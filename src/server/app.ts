import { downloadPage } from './download-page.js';
import { isWebPagePath } from '../shared/web-routes.js';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import serveStatic from '@fastify/static';
import { Readable } from 'node:stream';
import { existsSync, createReadStream, readFileSync } from 'node:fs';
import { clientReleases } from './releases.js';
import { registerUpdates } from './client-updates.js';
import { analytics, analyticsExport, analyticsQuery } from './analytics.js';
import { inModelAudience } from '../shared/model-access.js';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import { Store, type User } from './db.js';
import { ApiError, errorBody } from './errors.js';
import { formatValidationError } from './validation-message.js';
import { APP_VERSION } from '../shared/version.js';
import { profileForModel, resolveModelCapabilities } from '../shared/model-capabilities.js';
import { Gateway, type GatewayOptions } from './gateway.js';
import { digest, hashPassword, id, SecretBox, verifyPassword } from './security.js';
import { createModelSchema, keySchema, keyUpdateSchema, loginSchema, modelSchema, password, providerSchema, updateUserSchema, userSchema, validateEndpoint } from './schemas.js';
import type { ApiKey, Model, ModelAudience, Protocol } from '../shared/types.js';
import { AGENT_IDS, agentProtocol } from '../shared/types.js';
import type { Wire } from './protocols.js';

export interface AppOptions { store: Store; box: SecretBox; publicUrl: string; companyName?: string; demo?: boolean; development?: boolean; allowInsecureUpstream?: boolean; webRoot?: string; downloadsRoot?: string; updatesRoot?: string; gateway?: GatewayOptions }
export function credential(request: FastifyRequest) {
  const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const apiKey = request.headers['x-api-key'];
  if (bearer && typeof apiKey === 'string' && apiKey !== bearer) throw new ApiError(401, 'conflicting_credentials', '请求携带了不一致的访问凭证');
  return bearer ?? (typeof apiKey === 'string' ? apiKey : '') ?? '';
}
export async function createApp(options: AppOptions) {
  const { store, box } = options;
  const gateway = new Gateway(store, box, options.gateway);
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024, requestTimeout: 0 });
  const publicOrigin = new URL(options.publicUrl).origin;
  await app.register(cookie);
  await app.register(rateLimit, { global: false, max: 10, timeWindow: '1 minute' });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    if (request.url.startsWith('/api') || request.url.startsWith('/v1')) reply.header('Cache-Control', 'no-store');
    const origin = request.headers.origin;
    if (request.url.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method) && origin && origin !== publicOrigin && !(options.development && ['http://127.0.0.1:5173', 'http://localhost:5173'].includes(origin))) throw new ApiError(403, 'origin_rejected', '请求来源与公司服务地址不一致');
  });
  app.setErrorHandler((err, request, reply) => {
    const error = err instanceof ZodError ? new ApiError(400, 'invalid_input', formatValidationError(err))
      : err instanceof ApiError ? err : new ApiError((err as { statusCode?: number }).statusCode ?? 500, 'request_error', (err as { statusCode?: number }).statusCode === 429 ? '操作过于频繁，请稍后再试' : '请求处理失败，请检查输入或联系管理员');
    if (error.retryAfter) reply.header('Retry-After', String(error.retryAfter));
    const requestId = (err as { requestId?: string }).requestId;
    reply.code(error.status).send(errorBody(error, requestId, request.url.startsWith('/v1/messages') ? 'messages' : 'responses'));
  });
  const session = (request: FastifyRequest, admin = false, allowInitial = false) => {
    const auth = store.authenticate(credential(request) || request.cookies.aca_session || '', 'session');
    if (!auth) throw new ApiError(401, 'login_required', '请登录公司账号');
    if (!allowInitial && auth.user.mustChangePassword) throw new ApiError(403, 'password_change_required', '首次登录请先修改初始密码');
    if (admin && auth.user.role !== 'admin') throw new ApiError(403, 'admin_required', '该操作需要管理员权限');
    return auth;
  };
  const audit = (u: User, action: string, entity: string, details: Record<string, unknown> = {}) => store.audit(u.id, action, entity, details);
  const snapshot = (u: User, label: string) => store.saveVersion(u.id, label);
  const safeKey = (key: ApiKey) => {
    const { encryptedSecret: _, secretHash: __, ...safe } = key;
    const states = store.models().filter(m => m.routes.some(r => r.providerId === key.providerId)).map(m => ({ modelId: m.id, state: store.blocked(key, m.id), recoveryPending: store.recoveryScopes(key, m.id).length > 0 }));
    return { ...safe, lastSuccess: store.lastSuccess(key.id) ?? null, inFlight: gateway.pool.active(key.id), states };
  };
  app.get('/health', async () => { store.db.prepare('SELECT 1').get(); return { status: 'ok', version: APP_VERSION }; });
  app.head('/api/hello', async (_, reply) => reply.code(204).send());
  app.get('/api/meta', async () => ({ companyName: options.companyName ?? 'Coding Access', version: APP_VERSION, publicUrl: options.publicUrl, demo: Boolean(options.demo), capabilities: { downloadSharing: true, sessionPasswordChange: true } }));
  const downloadsRoot = options.downloadsRoot ?? resolve('release');
  const updates = registerUpdates(app, store, options.updatesRoot ?? resolve(downloadsRoot, '..', '.local', 'client-releases'), options.publicUrl, request => { session(request, true); });
  const downloads = () => { const legacy = clientReleases(downloadsRoot, APP_VERSION); const published = updates.downloads(); return published.length ? { ...legacy, downloads: published, downloadIssue: undefined } : legacy; };
  app.get('/api/client-release', async () => downloads());
  app.get('/download', async (request, reply) => {
    const q = z.object({ channel: z.enum(['stable', 'beta']).default('stable'), version: z.string().regex(/^[0-9A-Za-z.-]{1,64}$/).optional() }).parse(request.query);
    const files = updates.downloads(true);
    const chosen = files.find(f => (!q.version || f.version === q.version) && (q.channel === 'beta' || f.channel === 'stable'));
    const notes = chosen ? updates.releases().find(r => r.published && r.version === chosen.version)?.notes ?? '' : '';
    return reply.header('Cache-Control', 'no-store').header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'").type('text/html; charset=utf-8').send(downloadPage(options.companyName ?? 'Coding Access', files, q.channel, q.version, notes, request.headers['user-agent']));
  });
  app.get('/downloads/:name', async (request, reply) => {
    const name = (request.params as { name: string }).name; if (!downloads().downloads.some(d => d.name === name)) throw new ApiError(404, 'download_not_found', '此安装包尚未由管理员上传');
    return reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="${name}"`).send(createReadStream(resolve(downloadsRoot, name)));
  });
  app.post('/api/auth/login', { config: { rateLimit: { hook: 'preHandler', max: 10, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => `${req.ip}:${digest(String((req.body as Wire)?.username ?? '').toLowerCase())}` } } }, async (request, reply) => {
    const body = loginSchema.parse(request.body); const user = store.userByName(body.username);
    if (!user?.enabled || !await verifyPassword(body.password, user.passwordHash)) throw new ApiError(401, 'invalid_login', '账号或密码不正确');
    const issued = store.issue(user.id, 'session', body.device);
    reply.setCookie('aca_session', issued.token, { httpOnly: true, sameSite: 'strict', secure: publicOrigin.startsWith('https:'), path: '/', maxAge: 7 * 86400 });
    audit(user, 'login', user.id, { client: body.client });
    return { user: store.publicUser(user), ...(body.client === 'desktop' ? { sessionToken: issued.token } : {}) };
  });
  app.get('/api/auth/me', async request => ({ user: store.publicUser(session(request, false, true).user) }));
  app.post('/api/auth/password', async request => {
    const { user } = session(request, false, true);
    const body = z.object({ currentPassword: z.string().optional(), newPassword: password }).parse(request.body);
    if (body.currentPassword !== undefined && !await verifyPassword(body.currentPassword, user.passwordHash)) throw new ApiError(400, 'wrong_password', '当前密码不正确');
    store.saveUser({ ...user, passwordHash: await hashPassword(body.newPassword), mustChangePassword: false });
    audit(user, 'password_changed', user.id); return { ok: true };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const { user, credentialId, device } = session(request, false, true);
    store.revoke(user.id, credentialId);
    if (device !== 'browser') store.revoke(user.id, undefined, device);
    reply.clearCookie('aca_session', { path: '/' }); return { ok: true };
  });
  app.post('/api/auth/device-logout', async request => {
    const raw = credential(request); const auth = store.authenticate(raw, 'api') ?? store.authenticate(raw, 'session');
    if (!auth) throw new ApiError(401, 'already_revoked', '凭证已失效');
    store.revoke(auth.user.id, undefined, auth.device); audit(auth.user, 'credentials_revoked', auth.credentialId); return { ok: true };
  });
  app.get('/api/models', async request => {
    const { user } = session(request);
    const { agent } = request.query as { agent?: string }; return { models: gateway.catalog(user, agent) };
  });
  app.get('/api/me/stats', async request => { const { providers: _, ...stats } = gateway.store.stats(session(request).user.id); return stats; });
  app.get('/api/me/analytics', async request => analytics(store, analyticsQuery.parse(request.query), session(request).user.id));
  app.get('/api/admin/analytics-export', async (request, reply) => { session(request, true); const q = analyticsQuery.parse(request.query); return reply.header('Content-Type','text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="coding-access-usage.csv"').send(Readable.from(analyticsExport(store, q))); });
  app.get('/api/admin/analytics', async request => { session(request, true); return analytics(store, analyticsQuery.parse(request.query)); });
  app.get('/api/me/requests', async request => ({ requests: store.requests({ userId: session(request).user.id }) }));
  app.get('/api/me/credential-status', async request => {
    const { user } = session(request); const { credentialId, since, modelId, agent } = z.object({ credentialId: z.string(), since: z.coerce.number().nonnegative().default(0), modelId: z.string(), agent: z.enum(AGENT_IDS) }).parse(request.query);
    const row = store.db.prepare("SELECT id,model_id,agent,status,started_at,error_code FROM requests WHERE user_id=? AND credential_id=? AND started_at>=? AND model_id=? AND (agent=? OR (? IN ('codex-cli','codex-desktop') AND agent='codex')) ORDER BY started_at DESC LIMIT 1").get(user.id, credentialId, since, modelId, agent, agent);
    return { request: row ?? null };
  });
  app.post('/api/credentials', async request => {
    const { user, device } = session(request);
    if (device === 'browser') throw new ApiError(400, 'desktop_required', '请在桌面客户端完成工具配置');
    store.db.prepare("UPDATE tokens SET revoked=1 WHERE user_id=? AND kind='api' AND device=?").run(user.id, device);
    const issued = store.issue(user.id, 'api', device); audit(user, 'credential_issued', issued.id);
    return { apiKey: issued.token, credentialId: issued.id, baseUrl: options.publicUrl };
  });
  app.get('/api/admin/overview', async request => {
    session(request, true);
    const period = z.object({ period: z.enum(['today', '7']).default('7') }).parse(request.query).period;
    const since = Math.floor((Date.now() + 8 * 3600_000) / 86400_000) * 86400_000 - 8 * 3600_000 - (period === 'today' ? 0 : 6 * 86400_000);
    return { stats: store.stats(undefined, since), employees: store.users().length, models: store.models().length, keys: store.keys().map(safeKey), events: store.events(), live: gateway.pool.snapshot(), queued: gateway.queue.queued };
  });
  app.get('/api/admin/users', async request => { session(request, true); return { users: store.users().map(u => store.publicUser(u)) }; });
  const rejectLegacyPermissions = (body: unknown) => {
    if (body && typeof body === 'object' && 'models' in body) throw new ApiError(409, 'model_permissions_moved', '模型权限已移至模型发布范围，请刷新页面后操作');
  };
  app.post('/api/admin/users', async request => {
    const { user: actor } = session(request, true); rejectLegacyPermissions(request.body); const body = userSchema.parse(request.body);
    if (store.userByName(body.username)) throw new ApiError(409, 'username_exists', '账号名称已存在');
    const { password: raw, ...data } = body;
    const user: User = { ...data, models: [], id: id('user'), enabled: true, mustChangePassword: true, createdAt: Date.now(), passwordHash: await hashPassword(raw) };
    store.saveUser(user); audit(actor, 'user_created', user.id); return { user: store.publicUser(user) };
  });
  app.put('/api/admin/users/:id', async request => {
    const { user: actor } = session(request, true); const userId = (request.params as { id: string }).id;
    const current = store.user(userId); if (!current) throw new ApiError(404, 'user_not_found', '员工不存在');
    rejectLegacyPermissions(request.body); const data = updateUserSchema.parse(request.body);
    if (actor.id === userId && (!data.enabled || data.role !== 'admin')) throw new ApiError(400, 'self_disable', '请由其他管理员执行当前管理员的停用或角色调整');
    const user = { ...current, ...data };
    store.transaction(() => { store.saveUser(user); if (!data.enabled) store.revoke(userId); });
    audit(actor, data.enabled ? 'user_updated' : 'user_disabled', userId); return { user: store.publicUser(user) };
  });
  app.post('/api/admin/users/:id/reset-password', async request => {
    const { user: actor } = session(request, true); const userId = (request.params as { id: string }).id;
    const current = store.user(userId); if (!current) throw new ApiError(404, 'user_not_found', '员工不存在');
    const body = z.object({ password }).parse(request.body);
    store.saveUser({ ...current, passwordHash: await hashPassword(body.password), mustChangePassword: true }); store.revoke(userId);
    audit(actor, 'password_reset', userId); return { ok: true };
  });
  app.post('/api/admin/users/:id/revoke', async request => { const { user } = session(request, true); const userId = (request.params as { id: string }).id; store.revoke(userId); audit(user, 'credentials_revoked', userId); return { ok: true }; });
  app.get('/api/admin/providers', async request => { session(request, true); return { providers: store.providers() }; });
  const saveProvider = async (request: FastifyRequest) => {
    const { user } = session(request, true); const data = providerSchema.parse(request.body);
    for (const url of Object.values(data.endpoints)) validateEndpoint(url!, options.allowInsecureUpstream);
    for (const h of Object.keys(data.headers)) if (/authorization|api.?key|cookie|token|secret|host|content-length/i.test(h)) throw new ApiError(400, 'reserved_header', '鉴权信息请放入 Key 池，额外请求头不能覆盖鉴权或连接字段');
    const providerId = (request.params as { id?: string }).id ?? id('provider');
    snapshot(user, '更新接入前'); store.saveProvider({ ...data, id: providerId, createdAt: store.provider(providerId)?.createdAt ?? Date.now() }); audit(user, 'provider_saved', providerId);
    return { provider: store.provider(providerId) };
  };
  app.post('/api/admin/providers', saveProvider); app.put('/api/admin/providers/:id', saveProvider);
  app.delete('/api/admin/providers/:id', async request => {
    const { user } = session(request, true); const providerId = (request.params as { id: string }).id; const provider = store.provider(providerId);
    if (!provider) throw new ApiError(404, 'provider_not_found', '接入不存在');
    if (store.keys().some(k => k.providerId === providerId) || store.models().some(m => m.routes.some(r => r.providerId === providerId))) throw new ApiError(409, 'provider_in_use', '请先移除关联的模型路由，并删除其密钥，再删除接入');
    snapshot(user, '删除接入前'); store.db.prepare('DELETE FROM providers WHERE id=?').run(providerId); audit(user, 'provider_deleted', providerId); return { ok: true };
  });
  app.get('/api/admin/models', async request => { session(request, true); return { models: store.models() }; });
  const validateModelRoutes = (model: z.infer<typeof createModelSchema>) => {
    const knownModels = new Set<string>();
    for (const route of model.routes) {
      const provider = store.provider(route.providerId);
      if (!provider) throw new ApiError(400, 'provider_not_found', '模型引用的接入不存在');
      const profile = profileForModel(provider, route.upstreamModel);
      if (profile) knownModels.add(profile.id);
    }
    if (knownModels.size > 1) throw new ApiError(400, 'mixed_model_pool', '同模型资源池不能混用不同型号，请分别创建模型');
  };
  const validateAudience = (audience: ModelAudience, enabled: boolean, current?: Model) => {
    if (audience.type !== 'selected') return;
    if (audience.userIds.some(userId => !store.user(userId))) throw new ApiError(400, 'audience_user_not_found', '指定的成员不存在，请刷新成员列表');
    // Legacy admin-only models can still be edited without expanding access.
    const unchangedLegacy = current?.enabled && current.audience?.type === 'selected' && !current.audience.userIds.length;
    if (enabled && !audience.userIds.length && !unchangedLegacy) throw new ApiError(400, 'empty_model_audience', '请至少选择一位成员，或选择全体成员后发布；也可先保存草稿');
  };
  app.post('/api/admin/models', async (request, reply) => {
    const { user } = session(request, true); const parsed = createModelSchema.parse(request.body);
    validateModelRoutes(parsed);
    const audience = parsed.audience ?? { type: 'all' as const };
    validateAudience(audience, parsed.enabled);
    const data = parsed.capabilityMode === 'automatic' ? resolveModelCapabilities(parsed, store.providers()) : parsed;
    const model = store.transaction(() => {
      const base = data.name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').slice(0, 100) || id('model').replace('_', '-');
      let modelId = base;
      for (let suffix = 2; store.model(modelId); suffix++) {
        const ending = `-${suffix}`; modelId = `${base.slice(0, 100 - ending.length)}${ending}`;
      }
      const created = { ...data, audience, everPublished: data.enabled, id: modelId, createdAt: Date.now() };
      snapshot(user, '新增模型前');
      // Creation must never use the upsert path: an existing ID belongs to an existing model.
      store.db.prepare('INSERT INTO models(id,data) VALUES(?,?)').run(created.id, JSON.stringify(created));
      audit(user, 'model_saved', created.id, { enabled: created.enabled });
      return created;
    });
    return reply.code(201).send({ model });
  });
  app.put('/api/admin/models/:id', async request => {
    const { user } = session(request, true); const parsed = modelSchema.parse(request.body);
    validateModelRoutes(parsed);
    const model = parsed.capabilityMode === 'automatic' ? resolveModelCapabilities(parsed, store.providers()) : parsed;
    if (model.id !== (request.params as { id: string }).id) throw new ApiError(400, 'immutable_model_id', '模型 ID 与请求路径不一致');
    const current = store.model(model.id);
    if (!current) throw new ApiError(404, 'model_not_found', '模型不存在，请刷新模型目录');
    const audience = model.audience ?? current.audience!;
    validateAudience(audience, model.enabled, current);
    store.transaction(() => {
      snapshot(user, '更新模型前');
      store.saveModel({ ...model, audience, createdAt: current.createdAt });
      audit(user, 'model_saved', model.id, { enabled: model.enabled, audienceType: audience.type, memberCount: audience.type === 'selected' ? audience.userIds.length : undefined });
    });
    return { model: store.model(model.id) };
  });
  app.get('/api/admin/models/:id/impact', async request => {
    session(request, true); const modelId = (request.params as { id: string }).id;
    const model = store.model(modelId); if (!model) throw new ApiError(404, 'model_not_found', '模型不存在');
    return { users: store.users().filter(u => u.enabled && u.role !== 'admin' && inModelAudience(u, model)).map(u => store.publicUser(u)), recentRequests: store.requests({ modelId, limit: 20 }) };
  });
  app.delete('/api/admin/models/:id', async request => {
    const { user } = session(request, true); const modelId = (request.params as { id: string }).id; const model = store.model(modelId);
    if (!model) throw new ApiError(404, 'model_not_found', '模型不存在');
    if (model.enabled || store.db.prepare("SELECT 1 FROM requests WHERE model_id=? AND status='running'").get(modelId)) throw new ApiError(409, 'model_in_use', '请先停用模型，并等待正在运行的请求结束');
    snapshot(user, '删除模型前'); store.transaction(() => {
      store.db.prepare('DELETE FROM models WHERE id=?').run(modelId);
      store.users().filter(u => u.models.includes(modelId)).forEach(u => store.saveUser({ ...u, models: u.models.filter(m => m !== modelId) }));
    }); audit(user, 'model_deleted', modelId); return { ok: true };
  });
  app.get('/api/admin/keys', async request => { session(request, true); return { keys: store.keys().map(safeKey), live: gateway.pool.live(), queued: gateway.queue.queued, updatedAt: Date.now() }; });
  app.post('/api/admin/keys', async request => {
    const { user } = session(request, true); const items = z.array(keySchema).min(1).max(100).parse((request.body as Wire)?.keys);
    const created: ApiKey[] = items.map(({ secret, ...item }) => {
      if (!store.provider(item.providerId)) throw new ApiError(400, 'provider_not_found', '接入不存在');
      return { ...item, id: id('key'), enabled: true, secretHash: digest(secret), encryptedSecret: box.seal(secret), hint: `••••${secret.slice(-4)}`, createdAt: Date.now() };
    });
    const existing = new Set(store.keys().map(k => k.secretHash));
    for (const item of created) { if (existing.has(item.secretHash)) throw new ApiError(409, 'duplicate_key', '导入内容包含已保存或重复的 Key'); existing.add(item.secretHash); }
    store.transaction(() => created.forEach(k => store.saveKey(k))); audit(user, 'keys_imported', created[0].providerId, { count: created.length }); return { keys: created.map(safeKey) };
  });
  app.put('/api/admin/keys/:id', async request => {
    const { user } = session(request, true); const keyId = (request.params as { id: string }).id;
    const current = store.key(keyId); if (!current) throw new ApiError(404, 'key_not_found', 'Key 不存在');
    const { secret, ...data } = keyUpdateSchema.parse(request.body);
    const providerChanged = data.providerId !== undefined && data.providerId !== current.providerId;
    if (data.providerId !== undefined && !store.provider(data.providerId)) throw new ApiError(400, 'provider_not_found', '目标接入不存在，请重新选择');
    if (providerChanged && gateway.pool.active(keyId)) throw new ApiError(409, 'key_in_use', '此密钥仍有请求运行，请等待结束后再切换所属接入');
    if (secret && store.keys().some(k => k.id !== keyId && k.secretHash === digest(secret))) throw new ApiError(409, 'duplicate_key', '该 Key 已保存在资源池中');
    const key = { ...current, ...data, ...(secret ? { encryptedSecret: box.seal(secret), secretHash: digest(secret), hint: `••••${secret.slice(-4)}` } : {}) };
    store.transaction(() => {
      store.saveKey(key);
      if (providerChanged) store.resetKeyBinding(key);
      else if (secret) store.resetKey(key);
      audit(user, 'key_updated', keyId, providerChanged ? { previousProviderId: current.providerId, providerId: key.providerId } : {});
    });
    return { key: safeKey(key) };
  });
  app.post('/api/admin/keys/:id/reset', async request => { const { user } = session(request, true); const key = store.key((request.params as { id: string }).id); if (!key) throw new ApiError(404, 'key_not_found', 'Key 不存在'); store.resetKey(key); audit(user, 'key_reset', key.id); return { ok: true }; });
  app.delete('/api/admin/keys/:id', async request => {
    const { user } = session(request, true); const keyId = (request.params as { id: string }).id; const key = store.key(keyId);
    if (!key) throw new ApiError(404, 'key_not_found', 'Key 不存在');
    if (gateway.pool.active(keyId)) throw new ApiError(409, 'key_in_use', '此密钥仍有请求运行，请等待结束后再删除');
    store.db.prepare('DELETE FROM keys WHERE id=?').run(keyId); audit(user, 'key_deleted', keyId); return { ok: true };
  });
  app.post('/api/admin/keys/:id/check', async request => {
    const { user } = session(request, true); const keyId = (request.params as { id: string }).id;
    const key = store.key(keyId); if (!key) throw new ApiError(404, 'key_not_found', 'Key 不存在');
    const body = z.object({ modelId: z.string(), agent: z.enum(AGENT_IDS) }).parse(request.body);
    const model = store.model(body.modelId); if (!model?.enabled) throw new ApiError(400, 'model_not_published', '请先保存并发布用于验证的模型');
    const issued = store.issue(user.id, 'api', 'admin-connection-check');
    try {
      const protocol = agentProtocol(body.agent);
      const checkOutput = Math.min(64, model.maxOutputTokens ?? 64);
      const payload = protocol === 'messages' ? { model: model.id, max_tokens: checkOutput, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: true } : { model: model.id, max_output_tokens: checkOutput, input: 'Reply with OK.', stream: true };
      const result = await gateway.execute(issued.token, payload, protocol, body.agent, AbortSignal.timeout(25_000), {}, key.id);
      if (result.stream) for await (const _ of result.stream) { /* Drain the real stream to verify completion. */ }
      const outcome = store.requests({ query: result.requestId })[0];
      audit(user, 'key_checked', key.id, { modelId: model.id, agent: body.agent, requestId: result.requestId });
      return { ok: outcome?.status === 'success', requestId: result.requestId, message: outcome?.status === 'success' ? options.demo ? '已完成一次本地模拟流式调用。演示模式不连接真实供应商。' : '已完成一次真实流式调用。工具调用与实际编程工具仍需按联调清单验证。' : '上游连接成功，但回复未完整完成，请查看调用记录。' };
    } finally { store.revoke(user.id, issued.id); }
  });
  app.get('/api/admin/requests', async request => { session(request, true); const q = z.object({ userId: z.string().optional(), modelId: z.string().optional(), agent: z.string().optional(), providerId: z.string().optional(), keyId: z.string().optional(), query: z.string().optional(), from: z.coerce.number().nonnegative().optional(), to: z.coerce.number().nonnegative().optional() }).parse(request.query); return { requests: store.requests(q) }; });
  app.get('/api/admin/requests/:id', async request => {
    session(request, true); const requestId = (request.params as { id: string }).id;
    return { attempts: store.attempts(requestId) };
  });
  app.get('/api/admin/versions', async request => { session(request, true); return { versions: store.versions() }; });
  app.post('/api/admin/versions/:id/restore', async request => {
    const { user } = session(request, true); const versionId = (request.params as { id: string }).id;
    snapshot(user, '恢复配置前'); store.restoreVersion(versionId); audit(user, 'configuration_restored', versionId); return { ok: true };
  });
  app.get('/api/admin/audit', async request => { session(request, true); return { records: store.db.prepare("SELECT a.*,json_extract(u.data,'$.name') AS actor_name FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 100").all() }; });
  app.get('/v1/models', async request => {
    const auth = store.authenticate(credential(request), 'api'); if (!auth) throw new ApiError(401, 'invalid_api_key', '公司访问凭证无效');
    const requestedAgent = request.headers['x-coding-agent'];
    const agent = typeof requestedAgent === 'string' && (AGENT_IDS as readonly string[]).includes(requestedAgent) ? requestedAgent : undefined;
    return { object: 'list', data: gateway.catalog(auth.user, agent).map(m => ({ id: m.id, object: 'model', owned_by: 'company', name: m.name, context_window: m.contextWindow })) };
  });
  for (const [path, protocol] of [['/v1/messages', 'messages'], ['/v1/chat/completions', 'chat'], ['/v1/responses', 'responses']] as const) {
    app.post(path, async (request, reply) => {
      const body = z.record(z.string(), z.unknown()).parse(request.body);
      const abort = new AbortController();
      const disconnect = () => { if (!reply.raw.writableEnded) abort.abort(); };
      reply.raw.once('close', disconnect);
      const forwarded = Object.fromEntries(Object.entries(request.headers).filter(([name, value]) => name.startsWith('anthropic-') && typeof value === 'string')) as Record<string, string>;
      const result = await gateway.execute(credential(request), body, protocol, String(request.headers['x-coding-agent'] ?? (protocol === 'messages' ? 'claude-code' : 'codex')), abort.signal, forwarded);
      reply.header('x-request-id', result.requestId);
      if (result.stream) return reply.header('Content-Type', 'text/event-stream; charset=utf-8').header('X-Accel-Buffering', 'no').send(Readable.from(result.stream));
      return result.json;
    });
  }
  const webRoot = options.webRoot ?? resolve('dist/web');
  // The same relative-asset build is used by native clients. Give browser deep
  // links a root base without changing the files packaged into those clients.
  const webIndex = resolve(webRoot, 'index.html');
  const browserHtml = existsSync(webIndex) ? readFileSync(webIndex, 'utf8').replace(/<head\b[^>]*>/i, '$&<base href="/">') : undefined;
  if (existsSync(webRoot)) await app.register(serveStatic, { root: webRoot, index: ['index.html'], list: false });
  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0];
    if (['GET', 'HEAD'].includes(request.method) && isWebPagePath(pathname) && browserHtml !== undefined) {
      return reply.code(200).header('Cache-Control', 'no-cache').type('text/html')
        .header('Content-Length', Buffer.byteLength(browserHtml)).send(request.method === 'HEAD' ? undefined : browserHtml);
    }
    return reply.code(404).send(errorBody(new ApiError(404, 'not_found', '接口不存在'), undefined, request.url.startsWith('/v1/messages') ? 'messages' : 'responses'));
  });
  return { app, gateway };
}
