import { test, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { createApp } from '../src/server/app.js';

test('release uploads require admin; draft, channel, minimum server, withdrawal and bytes are enforced', async () => {
  const f = await fixture(); const root = mkdtempSync(join(tmpdir(), 'aca-updates-'));
  const { app } = await createApp({ ...f, publicUrl: 'http://localhost:4317', updatesRoot: root });
  const cookie = `aca_session=${f.adminSession}`;
  try {
    const url = '/api/admin/client-artifacts?platform=darwin-aarch64&kind=updater&name=Coding-Access.app.tar.gz&signature=YWJj';
    expect((await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('fixture') })).statusCode).toBe(401);
    const upload = await app.inject({ method: 'POST', url, headers: { cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from('fixture') });
    expect(upload.statusCode).toBe(200); const artifact = upload.json(); expect(artifact.size).toBe(7);
    const installer = (await app.inject({ method: 'POST', url: '/api/admin/client-artifacts?platform=darwin-aarch64&kind=installer&name=Coding-Access.zip', headers: { cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from('installer') })).json();
    const draft = await app.inject({ method: 'POST', url: '/api/admin/client-releases', headers: { cookie }, payload: { version: '0.2.0-beta.5', channel: 'beta', notes: 'Test update', minServerVersion: '0.1.0', artifactIds: [artifact.id, installer.id] } });
    expect(draft.statusCode).toBe(200);
    const feed = '/api/client-updater/beta/darwin-aarch64/0.2.0-beta.4';
    expect((await app.inject(feed)).statusCode).toBe(204);
    expect((await app.inject(`/client-artifacts/${artifact.id}/${artifact.name}`)).statusCode).toBe(404);
    const publish = `/api/admin/client-releases/${draft.json().id}/publish`;
    expect((await app.inject({ method: 'POST', url: publish, headers: { cookie }, payload: { published: true } })).statusCode).toBe(200);
    const update = await app.inject(feed); expect(update.statusCode).toBe(200); expect(update.json()).toMatchObject({ version: '0.2.0-beta.5', signature: 'YWJj' });
    expect((await app.inject(feed.replace('/beta/', '/stable/'))).statusCode).toBe(204);
    expect((await app.inject(feed.replace('beta.4', 'beta.5'))).statusCode).toBe(204);
    expect((await app.inject(`/client-artifacts/${artifact.id}/${artifact.name}`)).body).toBe('fixture');
    await app.inject({ method: 'POST', url: publish, headers: { cookie }, payload: { published: false } });
    expect((await app.inject(feed)).statusCode).toBe(204);
    const future = await app.inject({ method: 'POST', url: '/api/admin/client-releases', headers: { cookie }, payload: { version: '1.0.0', channel: 'stable', notes: 'Requires newer server', minServerVersion: '9.0.0', artifactIds: [artifact.id, installer.id] } });
    expect(future.statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `/api/admin/client-releases/${future.json().id}/publish`, headers: { cookie }, payload: { published: true } });
    expect((await app.inject(feed)).statusCode).toBe(204);
    expect((await app.inject('/api/client-updates?platform=darwin-aarch64&channel=beta&current=0.2.0-beta.4')).json()).toMatchObject({ available: true, compatible: false, minServerVersion: '9.0.0' });
    expect((await app.inject('/api/client-updater/beta/windows-x86_64/0.2.0-beta.4')).statusCode).toBe(204);
    expect((await app.inject(`/client-artifacts/${artifact.id}/wrong.tar.gz`)).statusCode).toBe(404);
  } finally { await app.close(); f.store.close(); rmSync(root, { recursive: true, force: true }); }
});


test('installer-only legacy release can be completed in place; new publications must include updater for every platform', async () => {
  const f = await fixture(); const root = mkdtempSync(join(tmpdir(), 'aca-release-repair-'));
  const { app } = await createApp({ ...f, publicUrl: 'http://localhost:4317', updatesRoot: root });
  const headers = { cookie: `aca_session=${f.adminSession}` };
  const upload = async (platform: string, kind: string, name: string) => (await app.inject({ method: 'POST', url: `/api/admin/client-artifacts?${new URLSearchParams({ platform, kind, name, ...(kind === 'updater' ? { signature: 'YWJj' } : {}) })}`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: Buffer.from('test-package') })).json();
  const publish = (id: string) => app.inject({ method: 'POST', url: `/api/admin/client-releases/${id}/publish`, headers, payload: { published: true } });
  try {
    const installer = await upload('darwin-aarch64', 'installer', 'Coding-Access.zip');
    const updater = await upload('darwin-aarch64', 'updater', 'Coding-Access.app.tar.gz');
    const body = { version: '0.2.0-beta.6', channel: 'beta', notes: 'Legacy release', minServerVersion: '0.1.16', artifactIds: [installer.id] };
    const draft = (await app.inject({ method: 'POST', url: '/api/admin/client-releases', headers, payload: body })).json();
    expect((await publish(draft.id)).json().error.code).toBe('incomplete_release');
    // This is the state previously accepted by the old server, including the user's beta.6 release.
    f.store.db.prepare('UPDATE client_releases SET data=? WHERE id=?').run(JSON.stringify({ ...draft, published: true }), draft.id);
    const feed = '/api/client-updater/beta/darwin-aarch64/0.2.0-beta.5';
    expect((await app.inject(feed)).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/admin/client-releases', headers })).json().releases[0].missingArtifacts[0]).toContain('客户端无法应用内更新');
    const repair = { ...body, artifactIds: [installer.id, updater.id] };
    const url = `/api/admin/client-releases/${draft.id}`;
    expect((await app.inject({ method: 'PUT', url, payload: repair })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url, headers, payload: { ...repair, version: '0.2.0-beta.7' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url, headers, payload: { ...repair, notes: 'Changed' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PUT', url, headers, payload: { ...repair, artifactIds: [updater.id] } })).statusCode).toBe(409);
    const win = await upload('windows-x86_64', 'installer', 'Coding-Access.exe');
    expect((await app.inject({ method: 'PUT', url, headers, payload: { ...repair, artifactIds: [...repair.artifactIds, win.id] } })).statusCode).toBe(409);
    const repaired = await app.inject({ method: 'PUT', url, headers, payload: repair });
    expect(repaired.statusCode).toBe(200); expect(repaired.json().published).toBe(true);
    expect((await app.inject(feed)).json()).toMatchObject({ version: body.version, signature: 'YWJj' });
    expect((await app.inject(`/client-artifacts/${updater.id}/${updater.name}`)).body).toBe('test-package');
    expect((await app.inject({ url: '/api/admin/client-releases', headers })).json().releases[0].missingArtifacts).toEqual([]);

    const second = (await app.inject({ method: 'POST', url: '/api/admin/client-releases', headers, payload: { ...body, version: '0.2.0-beta.7', artifactIds: [...repair.artifactIds, win.id] } })).json();
    expect((await publish(second.id)).json().error.code).toBe('incomplete_release');
    // Never serve an older updater when latest metadata points to an incomplete newer release.
    f.store.db.prepare('UPDATE client_releases SET data=? WHERE id=?').run(JSON.stringify({ ...second, published: true }), second.id);
    // A Mac installer-only latest publication must not fall back to beta.6.
    f.store.db.prepare('UPDATE client_releases SET data=? WHERE id=?').run(JSON.stringify({ ...second, published: true, artifactIds: [installer.id, win.id] }), second.id);
    expect((await app.inject(feed)).statusCode).toBe(204);
    expect((await app.inject('/api/client-updates?platform=darwin-aarch64&channel=beta&current=0.2.0-beta.5')).json().latest).toBe('0.2.0-beta.7');
    // Same-size corruption is rejected before publication as well.
    writeFileSync(join(root, updater.id), 'bad--package');
    expect((await publish(draft.id)).json().error.code).toBe('artifact_changed');
  } finally { await app.close(); f.store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('public download page filters channels, supports pinned versions and removes withdrawn files', async () => {
  const f = await fixture(); const root = mkdtempSync(join(tmpdir(), 'aca-share-'));
  const { app } = await createApp({ ...f, publicUrl: 'http://localhost:4317', updatesRoot: root, companyName: '<img src=x onerror=alert(1)>' });
  const headers = { cookie: `aca_session=${f.adminSession}` };
  try {
    const ids: string[] = [];
    for (const [kind, name] of [['installer', 'Coding-Access.exe'], ['updater', 'Coding-Access-update.exe']]) {
      const upload = await app.inject({ method: 'POST', url: `/api/admin/client-artifacts?platform=windows-x86_64&kind=${kind}&name=${name}&signature=YWJj`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: Buffer.from('test-install') });
      expect(upload.statusCode).toBe(200); ids.push(upload.json().id);
    }
    const publish = async (version: string, channel: string) => {
      const draft = (await app.inject({ method: 'POST', url: '/api/admin/client-releases', headers, payload: { version, channel, notes: '<script>privateInjection()</script>', minServerVersion: '0.1.0', artifactIds: ids } })).json();
      expect((await app.inject('/download?channel=beta')).body).not.toContain('href="/client-artifacts/');
      const r = await app.inject({ method: 'POST', url: `/api/admin/client-releases/${draft.id}/publish`, headers, payload: { published: true } }); expect(r.statusCode).toBe(200); return draft.id;
    };
    const stable = await publish('0.2.0', 'stable');
    const draft = (await app.inject({ method: 'POST', url: '/api/admin/client-releases', headers, payload: { version: '0.3.0-beta.1', channel: 'beta', notes: '<script>privateInjection()</script>', minServerVersion: '0.1.0', artifactIds: ids } })).json();
    await app.inject({ method: 'POST', url: `/api/admin/client-releases/${draft.id}/publish`, headers, payload: { published: true } });
    const page = await app.inject('/download?channel=beta'); expect(page.statusCode).toBe(200); expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('0.3.0-beta.1'); expect(page.body).not.toContain('Coding-Access-update.exe');
    expect(page.body).not.toContain('<script>'); expect(page.body).not.toContain('<img src=x'); expect(page.body).not.toContain(f.adminSession);
    expect((await app.inject('/download?channel=stable')).body).toContain('0.2.0');
    expect((await app.inject('/download?channel=stable')).body).not.toContain('0.3.0-beta.1');
    expect((await app.inject('/download?channel=beta&version=0.2.0')).body).toContain('Coding-Access.exe');
    await app.inject({ method: 'POST', url: `/api/admin/client-releases/${stable}/publish`, headers, payload: { published: false } });
    expect((await app.inject('/download?channel=stable&version=0.2.0')).body).toContain('已撤回');
    await app.inject({ method: 'POST', url: `/api/admin/client-releases/${draft.id}/publish`, headers, payload: { published: false } });
    expect((await app.inject('/download?channel=beta')).body).not.toContain('href="/client-artifacts/');
    expect((await app.inject(`/client-artifacts/${ids[0]}/Coding-Access.exe`)).statusCode).toBe(404);
  } finally { await app.close(); f.store.close(); rmSync(root, { recursive: true, force: true }); }
});
