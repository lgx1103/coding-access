import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createReadStream, createWriteStream, existsSync, mkdirSync, lstatSync, unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import semver from 'semver';
import { z } from 'zod';
import type { Store } from './db.js';
import { ApiError } from './errors.js';
import { APP_VERSION } from '../shared/version.js';

const version = z.string().max(80).refine(v => semver.valid(v) === v, '请输入标准版本号，例如 0.2.0-beta.5');
const releaseSchema = z.object({ version, channel: z.enum(['stable', 'beta']), notes: z.string().min(1).max(20000), minServerVersion: version, artifactIds: z.array(z.string().uuid()).min(1).max(8) });
const uploadSchema = z.object({ platform: z.enum(['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']), kind: z.enum(['installer', 'updater']), name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}\.(zip|exe|gz)$/), signature: z.string().max(4096).optional() });
type Release = z.infer<typeof releaseSchema> & { id: string; published: boolean; createdAt: number };
type Artifact = z.infer<typeof uploadSchema> & { id: string; size: number; sha256: string };
export function registerUpdates(app: FastifyInstance, store: Store, root: string, publicUrl: string, authorize: (r: FastifyRequest) => void) {
  store.db.exec('CREATE TABLE IF NOT EXISTS client_releases(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS client_artifacts(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
  const artifacts = () => store.db.prepare('SELECT data FROM client_artifacts').all().map(r => JSON.parse(String(r.data)) as Artifact);
  const releases = () => store.db.prepare('SELECT data FROM client_releases').all().map(r => JSON.parse(String(r.data)) as Release);
  const save = (r: Release) => store.db.prepare('INSERT INTO client_releases VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(r.id, JSON.stringify(r));
  const existingFile = (a: Artifact) => { const path = resolve(root, a.id); return existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() && lstatSync(path).size === a.size; };
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
  app.post('/api/admin/client-artifacts', { onRequest: async request => authorize(request) }, async request => {
    const q = uploadSchema.parse(request.query);
    if (q.kind === 'updater' && (!q.signature || !/^[A-Za-z0-9+/=]+$/.test(q.signature))) throw new ApiError(400, 'signature_required', '更新包必须附带 Tauri 生成的签名');
    if (q.kind === 'updater' && !(q.platform.startsWith('darwin') ? q.name.endsWith('.tar.gz') : q.name.endsWith('.exe'))) throw new ApiError(400, 'wrong_artifact', 'macOS 更新使用 .tar.gz，Windows 更新使用 .exe');
    mkdirSync(root, { recursive: true, mode: 0o700 }); const id = randomUUID(); const path = resolve(root, id); let size = 0; const hash = createHash('sha256');
    const meter = new Transform({ transform(chunk, _encoding, next) { size += chunk.length; if (size > 256 * 1024 * 1024) return next(new ApiError(413, 'artifact_too_large', '文件不能超过 256 MB')); hash.update(chunk); next(null, chunk); } });
    try {
      await pipeline(request.body as Readable, meter, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
      if (!size) throw new ApiError(400, 'empty_artifact', '安装包不能为空');
      const artifact: Artifact = { ...q, id, size, sha256: hash.digest('hex') };
      store.db.prepare('INSERT INTO client_artifacts VALUES(?,?)').run(id, JSON.stringify(artifact)); return artifact;
    } catch (e) { if (existsSync(path)) unlinkSync(path); throw e; }
  });
  const platformNames: Record<string, string> = { 'darwin-aarch64': 'macOS Apple Silicon', 'darwin-x86_64': 'macOS Intel', 'windows-x86_64': 'Windows x64' };
  const missingArtifacts = (ids: string[], all: Artifact[]) => {
    const used = all.filter(a => ids.includes(a.id));
    return [...new Set(used.map(a => a.platform))].flatMap(platform => ['installer', 'updater'].filter(kind => !used.some(a => a.platform === platform && a.kind === kind)).map(kind => `${platformNames[platform]}：缺少${kind === 'updater' ? '签名更新包（客户端无法应用内更新）' : '完整安装包'}`));
  };
  const validateFiles = async (ids: string[], complete: boolean) => {
    const all = artifacts(); const used = ids.map(id => all.find(a => a.id === id));
    if (used.some(a => !a || !existingFile(a))) throw new ApiError(400, 'missing_artifact', '发布文件不存在或已损坏');
    if (new Set(used.map(a => `${a!.platform}:${a!.kind}`)).size !== used.length) throw new ApiError(400, 'duplicate_platform', '同一平台和类型只能选择一个文件');
    if (complete) {
      const missing = missingArtifacts(ids, all);
      if (missing.length) throw new ApiError(400, 'incomplete_release', `无法发布：${missing.join('；')}`);
      for (const a of used) {
        if (a!.kind === 'updater' && !a!.signature) throw new ApiError(400, 'signature_required', '更新包缺少签名，请重新上传');
        const hash = createHash('sha256'); for await (const chunk of createReadStream(resolve(root, a!.id))) hash.update(chunk);
        if (hash.digest('hex') !== a!.sha256) throw new ApiError(400, 'artifact_changed', '文件校验失败，不能发布');
      }
    }
  };
  app.get('/api/admin/client-releases', async request => { authorize(request); const all = artifacts(); return { releases: releases().sort((a, b) => semver.rcompare(a.version, b.version)).map(r => ({ ...r, missingArtifacts: missingArtifacts(r.artifactIds, all) })), artifacts: all }; });
  app.post('/api/admin/client-releases', async request => {
    authorize(request); const value = releaseSchema.parse(request.body);
    if (value.channel === 'stable' && semver.prerelease(value.version)) throw new ApiError(400, 'beta_in_stable', '预发布版本只能进入测试通道');
    if (releases().some(r => r.version === value.version)) throw new ApiError(409, 'duplicate_version', '版本已存在，请发布新的版本号');
    await validateFiles(value.artifactIds, false);
    const release: Release = { ...value, id: randomUUID(), published: false, createdAt: Date.now() }; save(release); return release;
  });
  app.put('/api/admin/client-releases/:id', async request => {
    authorize(request);
    const id = (request.params as { id: string }).id;
    const release = releases().find(r => r.id === id);
    if (!release) throw new ApiError(404, 'release_missing', '版本不存在');
    const value = releaseSchema.parse(request.body);
    if (value.version !== release.version) throw new ApiError(400, 'immutable_version', '已有版本号不能修改');
    if (value.channel === 'stable' && semver.prerelease(value.version)) throw new ApiError(400, 'beta_in_stable', '预发布版本只能进入测试通道');
    if (release.published) {
      // Repair an incomplete legacy publication without withdrawing the version or
      // replacing bytes already served to clients. Other changes require a new release.
      const all = artifacts(); const platforms = new Set(all.filter(a => release.artifactIds.includes(a.id)).map(a => a.platform));
      if (value.notes !== release.notes || value.channel !== release.channel || value.minServerVersion !== release.minServerVersion || release.artifactIds.some(id => !value.artifactIds.includes(id)) || value.artifactIds.some(id => { const a = all.find(a => a.id === id); return a && !platforms.has(a.platform); })) {
        throw new ApiError(409, 'published_release_immutable', '已发布版本只能补全缺少的文件；替换文件或修改信息请发布新版本');
      }
    }
    await validateFiles(value.artifactIds, release.published);
    const updated = { ...release, ...value }; save(updated); return updated;
  });
  app.post('/api/admin/client-releases/:id/publish', async request => {
    authorize(request); const id = (request.params as { id: string }).id; const release = releases().find(r => r.id === id);
    if (!release) throw new ApiError(404, 'release_missing', '版本不存在');
    const { published } = z.object({ published: z.boolean() }).parse(request.body);
    if (published) await validateFiles(release.artifactIds, true);
    release.published = published; save(release); return release;
  });
  app.get('/api/client-updates', async request => {
    const q = z.object({ platform: uploadSchema.shape.platform, channel: z.enum(['stable', 'beta']).default('stable'), current: version }).parse(request.query);
    const all = artifacts();
    const release = releases().filter(r => r.published && (q.channel === 'beta' || r.channel === 'stable') && r.artifactIds.some(id => all.some(a => a.id === id && a.platform === q.platform))).sort((a, b) => semver.rcompare(a.version, b.version))[0];
    if (!release) return { available: false, latest: null };
    const files = all.filter(a => release.artifactIds.includes(a.id) && a.platform === q.platform).map(a => ({ ...a, url: `/client-artifacts/${a.id}/${a.name}` }));
    return { available: semver.gt(release.version, q.current), latest: release.version, compatible: semver.gte(APP_VERSION, release.minServerVersion), notes: release.notes, minServerVersion: release.minServerVersion, artifacts: files };
  });
  app.get('/api/client-updater/:channel/:platform/:current', async (request, reply) => {
    const q = z.object({ platform: uploadSchema.shape.platform, channel: z.enum(['stable', 'beta']), current: version }).parse(request.params);
    const all = artifacts();
    const release = releases().filter(r => r.published && (q.channel === 'beta' || r.channel === 'stable') && r.artifactIds.some(id => all.some(a => a.id === id && a.platform === q.platform))).sort((a, b) => semver.rcompare(a.version, b.version))[0];
    if (!release || !semver.gt(release.version, q.current) || !semver.gte(APP_VERSION, release.minServerVersion)) return reply.code(204).send();
    const a = all.find(a => release.artifactIds.includes(a.id) && a.kind === 'updater' && a.platform === q.platform);
    if (!a) return reply.code(204).send();
    return { version: release.version, notes: release.notes, pub_date: new Date(release.createdAt).toISOString(), url: `${new URL(publicUrl).origin}/client-artifacts/${a.id}/${a.name}`, signature: a.signature };
  });
  app.get('/client-artifacts/:id/:name', async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string }; const a = artifacts().find(a => a.id === id && a.name === name);
    if (!a || !existingFile(a) || !releases().some(r => r.published && r.artifactIds.includes(id))) throw new ApiError(404, 'artifact_missing', '文件未发布或已撤回');
    return reply.header('Content-Type', 'application/octet-stream').header('Content-Length', a.size).header('Content-Disposition', `attachment; filename="${a.name}"`).send(createReadStream(resolve(root, id)));
  });
  return { releases, artifacts, downloads: (allVersions = false) => {
    const all = artifacts(); const result: any[] = []; const seen = new Set<string>();
    for (const r of releases().filter(r => r.published).sort((a,b) => semver.rcompare(a.version,b.version))) for (const a of all.filter(a => r.artifactIds.includes(a.id) && a.kind === 'installer')) {
      if ((!allVersions && seen.has(a.platform)) || !existingFile(a)) continue; seen.add(a.platform);
      result.push({ name:a.name, url:`/client-artifacts/${a.id}/${a.name}`, size:a.size, platform:a.platform.startsWith('darwin')?'macOS':'Windows', arch:a.platform.endsWith('aarch64')?'Apple Silicon':'x64', version:r.version, channel:r.channel });
    }
    return result;
  } };
}
