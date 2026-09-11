import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ApiKey, Model, Provider, PublicUser, Usage } from '../shared/types.js';
import { resolveModelCapabilities, unifyModelCapabilities } from '../shared/model-capabilities.js';
import { canUseModel } from '../shared/model-access.js';
import { analytics, analyticsQuery } from './analytics.js';
import { digest, id, token } from './security.js';

type Row = Record<string, any>;
export interface User extends PublicUser { passwordHash: string }
export interface AttemptRecord extends Usage {
  id: string; requestId: string; providerId: string; keyId: string; startedAt: number;
  finishedAt?: number; status: string; httpStatus?: number; code?: string; message?: string; ambiguous?: boolean;
}

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,device TEXT NOT NULL,expires_at INTEGER,revoked INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS keys(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL REFERENCES providers(id),secret_hash TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS states(scope TEXT PRIMARY KEY,until_ms INTEGER NOT NULL,reason TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS key_success(key_id TEXT PRIMARY KEY,last_ok INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),model_id TEXT NOT NULL,agent TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,status TEXT NOT NULL,error_code TEXT,error_message TEXT,first_token_ms INTEGER);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES requests(id),provider_id TEXT NOT NULL,key_id TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,status TEXT NOT NULL,http_status INTEGER,code TEXT,message TEXT,input_tokens INTEGER,output_tokens INTEGER,cached_tokens INTEGER,ambiguous INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS idx_requests_time ON requests(started_at);
      CREATE INDEX IF NOT EXISTS idx_requests_user ON requests(user_id,started_at);
      CREATE INDEX IF NOT EXISTS idx_attempts_request ON attempts(request_id);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,subject TEXT NOT NULL,code TEXT NOT NULL,message TEXT NOT NULL,first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,count INTEGER NOT NULL,resolved_at INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_active_events ON events(subject,code) WHERE resolved_at IS NULL;
      CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,action TEXT NOT NULL,entity TEXT NOT NULL,details TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS config_versions(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,actor TEXT NOT NULL,label TEXT NOT NULL,snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS response_routes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,model_id TEXT NOT NULL,key_id TEXT NOT NULL,created_at INTEGER NOT NULL);
    `);
    if (!(this.db.prepare('PRAGMA table_info(requests)').all() as Row[]).some(r => r.name === 'credential_id')) this.db.exec('ALTER TABLE requests ADD COLUMN credential_id TEXT');
    for (const column of ['user_name', 'model_name']) if (!(this.db.prepare('PRAGMA table_info(requests)').all() as Row[]).some(r => r.name === column)) this.db.exec(`ALTER TABLE requests ADD COLUMN ${column} TEXT`);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_requests_model_time ON requests(model_id,started_at); CREATE INDEX IF NOT EXISTS idx_attempts_provider_request ON attempts(provider_id,request_id)');
    // Idempotently freeze legacy per-user grants into each model. Never infer all-member access.
    this.transaction(() => {
      for (const model of this.list<Model>('models')) if (!model.audience || model.everPublished === undefined) {
        const wasUsed = Boolean(this.db.prepare('SELECT 1 FROM requests WHERE model_id=? LIMIT 1').get(model.id));
        this.saveModel({ ...model, everPublished: model.everPublished ?? (model.enabled || wasUsed) });
      }
    });
    this.migrateModelCapabilities();
    // A restart cannot establish what the previous process's upstream finished.
    this.db.exec("UPDATE attempts SET status='interrupted',ambiguous=1,code='server_restart' WHERE status='running'; UPDATE requests SET status='interrupted',error_code='server_restart' WHERE status='running';");
  }
  migrateModelCapabilities() {
    const legacy = this.list<Model>('models').filter(model => model.capabilityMode !== 'unified');
    if (!legacy.length) return;
    this.transaction(() => {
      // Store raw pre-migration values, including route-level overrides.
      this.db.prepare('INSERT INTO config_versions VALUES(?,?,?,?,?)').run(id('version'), Date.now(), 'system', '统一模型能力配置前', JSON.stringify({ providers: this.providers(), models: this.list<Model>('models') }));
      for (const model of legacy) this.saveModel(unifyModelCapabilities(model, this.providers()));
    });
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  private json<T>(table: 'providers' | 'models' | 'users' | 'keys', rowId: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(rowId) as Row | undefined;
    return row ? JSON.parse(row.data) as T : undefined;
  }
  private list<T>(table: 'providers' | 'models' | 'users' | 'keys'): T[] {
    return (this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() as Row[]).map(r => JSON.parse(r.data));
  }
  user(userId: string) { return this.json<User>('users', userId); }
  userByName(username: string) {
    const row = this.db.prepare('SELECT data FROM users WHERE username=?').get(username) as Row | undefined;
    return row ? JSON.parse(row.data) as User : undefined;
  }
  users() { return this.list<User>('users'); }
  saveUser(user: User) {
    this.db.prepare('INSERT INTO users(id,username,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,data=excluded.data').run(user.id, user.username, JSON.stringify(user));
  }
  publicUser(user: User): PublicUser {
    const { passwordHash: _, ...publicUser } = user;
    return { ...publicUser, models: this.models().filter(model => canUseModel(user, model)).map(model => model.id) };
  }
  issue(userId: string, kind: 'session' | 'api', device: string) {
    const raw = token(kind === 'session' ? 'aca_session' : 'aca');
    const tokenId = id('cred');
    this.db.prepare('INSERT INTO tokens(id,hash,user_id,kind,device,expires_at,created_at) VALUES(?,?,?,?,?,?,?)').run(tokenId, digest(raw), userId, kind, device, kind === 'session' ? Date.now() + 7 * 86400_000 : null, Date.now());
    return { token: raw, id: tokenId };
  }
  authenticate(raw: string, kind: 'session' | 'api') {
    const row = this.db.prepare('SELECT id,user_id,device FROM tokens WHERE hash=? AND kind=? AND revoked=0 AND (expires_at IS NULL OR expires_at>?)').get(digest(raw), kind, Date.now()) as Row | undefined;
    if (!row) return undefined;
    const user = this.user(row.user_id);
    return user?.enabled ? { user, credentialId: row.id as string, device: row.device as string } : undefined;
  }
  revoke(userId: string, credentialId?: string, device?: string) {
    if (credentialId) this.db.prepare('UPDATE tokens SET revoked=1 WHERE user_id=? AND id=?').run(userId, credentialId);
    else if (device) this.db.prepare('UPDATE tokens SET revoked=1 WHERE user_id=? AND device=?').run(userId, device);
    else this.db.prepare('UPDATE tokens SET revoked=1 WHERE user_id=?').run(userId);
  }
  providers() { return this.list<Provider>('providers'); }
  provider(providerId: string) { return this.json<Provider>('providers', providerId); }
  saveProvider(provider: Provider) { this.db.prepare('INSERT INTO providers(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(provider.id, JSON.stringify(provider)); }
  models() {
    const providers = this.providers();
    return this.list<Model>('models').map(model => model.capabilityMode === 'automatic' ? resolveModelCapabilities(model, providers) : model);
  }
  model(modelId: string) {
    const model = this.json<Model>('models', modelId);
    return model?.capabilityMode === 'automatic' ? resolveModelCapabilities(model, this.providers()) : model;
  }
  legacyAudience(modelId: string) { return { type: 'selected' as const, userIds: this.users().filter(user => user.models.includes(modelId)).map(user => user.id) }; }
  saveModel(model: Model) {
    const current = this.json<Model>('models', model.id);
    const normalized = { ...model, audience: model.audience ?? current?.audience ?? this.legacyAudience(model.id), everPublished: Boolean(model.enabled || model.everPublished || current?.everPublished) };
    this.db.prepare('INSERT INTO models(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(model.id, JSON.stringify(normalized));
  }
  keys() { return this.list<ApiKey>('keys'); }
  key(keyId: string) { return this.json<ApiKey>('keys', keyId); }
  saveKey(key: ApiKey) { this.db.prepare('INSERT INTO keys(id,provider_id,secret_hash,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id,secret_hash=excluded.secret_hash,data=excluded.data').run(key.id, key.providerId, key.secretHash, JSON.stringify(key)); }
  scopes(key: ApiKey, modelId: string): string[] {
    const rate = key.rateScope === 'group' ? `group:${key.providerId}:${key.group}` : key.rateScope === 'model' ? `key-model:${key.id}:${modelId}` : `key:${key.id}`;
    return [...new Set([`invalid:${key.id}`, `provider:${key.providerId}`, `provider-model:${key.providerId}:${modelId}`, `key:${key.id}`, `key-model:${key.id}:${modelId}`, rate])];
  }
  block(scope: string, until: number, reason: string) {
    this.db.prepare('INSERT INTO states(scope,until_ms,reason,updated_at) VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET until_ms=max(states.until_ms,excluded.until_ms),reason=excluded.reason,updated_at=excluded.updated_at').run(scope, until, reason, Date.now());
  }
  blocked(key: ApiKey, modelId: string, now = Date.now()) {
    for (const scope of this.scopes(key, modelId)) {
      const row = this.db.prepare('SELECT * FROM states WHERE scope=? AND until_ms>?').get(scope, now) as Row | undefined;
      if (row) return row;
    }
    return undefined;
  }
  resetKey(key: ApiKey) {
    this.db.prepare("DELETE FROM states WHERE scope=? OR scope=? OR substr(scope,1,length(?))=?").run(`invalid:${key.id}`, `key:${key.id}`, `key-model:${key.id}:`, `key-model:${key.id}:`);
    this.resolveEvent(key.id);
  }
  resetKeyBinding(key: ApiKey) {
    // Only clear this key's state. Shared provider/group blocks still protect other keys.
    this.resetKey(key);
    this.db.prepare('DELETE FROM key_success WHERE key_id=?').run(key.id);
    // Upstream response IDs belong to the original provider and cannot be continued there after moving.
    this.db.prepare('DELETE FROM response_routes WHERE key_id=?').run(key.id);
  }
  recoveryScopes(key: ApiKey, modelId: string) {
    return this.scopes(key, modelId).filter(scope => Boolean(this.db.prepare('SELECT 1 FROM states WHERE scope=? AND until_ms<=?').get(scope, Date.now())));
  }
  success(key: ApiKey, modelId?: string) {
    this.db.prepare('INSERT INTO key_success(key_id,last_ok) VALUES(?,?) ON CONFLICT(key_id) DO UPDATE SET last_ok=excluded.last_ok').run(key.id, Date.now());
    this.resolveEvent(key.id); this.resolveEvent(key.providerId);
    if (modelId) for (const scope of this.scopes(key, modelId)) this.db.prepare('DELETE FROM states WHERE scope=? AND until_ms<=?').run(scope, Date.now());
  }
  lastSuccess(keyId: string) { return (this.db.prepare('SELECT last_ok FROM key_success WHERE key_id=?').get(keyId) as Row | undefined)?.last_ok as number | undefined; }
  event(subject: string, code: string, message: string) {
    const existing = this.db.prepare('SELECT id FROM events WHERE subject=? AND code=? AND resolved_at IS NULL').get(subject, code) as Row | undefined;
    if (existing) this.db.prepare('UPDATE events SET last_at=?,count=count+1,message=? WHERE id=?').run(Date.now(), message, existing.id);
    else this.db.prepare('INSERT INTO events(id,subject,code,message,first_at,last_at,count) VALUES(?,?,?,?,?,?,1)').run(id('event'), subject, code, message, Date.now(), Date.now());
  }
  resolveEvent(subject: string) { this.db.prepare('UPDATE events SET resolved_at=? WHERE subject=? AND resolved_at IS NULL').run(Date.now(), subject); }
  events() { return this.db.prepare('SELECT * FROM events ORDER BY resolved_at IS NOT NULL,last_at DESC LIMIT 100').all(); }
  audit(userId: string, action: string, entity: string, details: Record<string, unknown> = {}) {
    this.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?)').run(id('audit'), userId, action, entity, JSON.stringify(details), Date.now());
  }
  beginRequest(userId: string, modelId: string, agent: string, credentialId?: string) {
    const requestId = id('req');
    this.db.prepare("INSERT INTO requests(id,user_id,model_id,agent,started_at,status,credential_id) VALUES(?,?,?,?,?,'running',?)").run(requestId, userId, modelId, agent, Date.now(), credentialId ?? null);
    this.db.prepare('UPDATE requests SET user_name=?,model_name=? WHERE id=?').run(this.user(userId)?.name ?? userId, this.model(modelId)?.name ?? modelId, requestId);
    return requestId;
  }
  finishRequest(requestId: string, status: string, code?: string, message?: string, firstTokenMs?: number) {
    this.db.prepare('UPDATE requests SET finished_at=?,status=?,error_code=?,error_message=?,first_token_ms=? WHERE id=?').run(Date.now(), status, code ?? null, message ?? null, firstTokenMs ?? null, requestId);
  }
  attempt(a: AttemptRecord) {
    this.db.prepare(`INSERT INTO attempts(id,request_id,provider_id,key_id,started_at,finished_at,status,http_status,code,message,input_tokens,output_tokens,cached_tokens,ambiguous)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET finished_at=excluded.finished_at,status=excluded.status,http_status=excluded.http_status,code=excluded.code,message=excluded.message,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cached_tokens=excluded.cached_tokens,ambiguous=excluded.ambiguous`).run(a.id,a.requestId,a.providerId,a.keyId,a.startedAt,a.finishedAt ?? null,a.status,a.httpStatus ?? null,a.code ?? null,a.message ?? null,a.input,a.output,a.cached,a.ambiguous ? 1 : 0);
  }
  requests(filter: { userId?: string; modelId?: string; agent?: string; providerId?: string; keyId?: string; query?: string; from?: number; to?: number; limit?: number } = {}) {
    const where: string[] = []; const args: (string | number)[] = [];
    if (filter.userId) { where.push('r.user_id=?'); args.push(filter.userId); }
    if (filter.modelId) { where.push('r.model_id=?'); args.push(filter.modelId); }
    if (filter.agent) { where.push('r.agent=?'); args.push(filter.agent); }
    if (filter.providerId || filter.keyId) {
      const clauses = ['a.request_id=r.id'];
      if (filter.providerId) { clauses.push('a.provider_id=?'); args.push(filter.providerId); }
      if (filter.keyId) { clauses.push('a.key_id=?'); args.push(filter.keyId); }
      where.push(`EXISTS (SELECT 1 FROM attempts a WHERE ${clauses.join(' AND ')})`);
    }
    if (filter.from) { where.push('r.started_at>=?'); args.push(filter.from); }
    if (filter.to) { where.push('r.started_at<=?'); args.push(filter.to); }
    if (filter.query) { where.push('(r.id LIKE ? OR r.error_code LIKE ?)'); args.push(`%${filter.query}%`, `%${filter.query}%`); }
    args.push(Math.min(filter.limit ?? 100, 1000));
    return this.db.prepare(`SELECT r.*,json_extract(u.data,'$.name') AS user_name,
      (SELECT COUNT(*) FROM attempts WHERE request_id=r.id) AS attempts,
      (SELECT SUM(input_tokens) FROM attempts WHERE request_id=r.id) AS input_tokens,
      (SELECT SUM(output_tokens) FROM attempts WHERE request_id=r.id) AS output_tokens,
      (SELECT COUNT(*) FROM attempts WHERE request_id=r.id AND (input_tokens IS NULL OR output_tokens IS NULL)) AS unknown_usage
      FROM requests r JOIN users u ON u.id=r.user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.started_at DESC LIMIT ?`).all(...args);
  }
  attempts(requestId: string) { return this.db.prepare('SELECT * FROM attempts WHERE request_id=? ORDER BY started_at,rowid').all(requestId); }
  stats(userId?: string, since = Math.floor((Date.now() + 8 * 3600_000) / 86400_000) * 86400_000 - 8 * 3600_000 - 6 * 86400_000): Row {
    const where = `r.started_at>=?${userId ? ' AND r.user_id=?' : ''}`;
    const args = userId ? [since, userId] : [since];
    const totals = analytics(this, analyticsQuery.parse({ from: since, to: Date.now() + 1 }), userId).totals;
    const daily = this.db.prepare(`SELECT strftime('%Y-%m-%d',r.started_at/1000,'unixepoch','+8 hours') AS day,COUNT(*) AS requests,SUM(r.status='success') AS success FROM requests r WHERE ${where} GROUP BY day ORDER BY day`).all(...args);
    const providers = this.db.prepare(`SELECT a.provider_id,COUNT(*) AS attempts,SUM(a.input_tokens) AS input_tokens,SUM(a.output_tokens) AS output_tokens,SUM(a.status='success') AS success FROM attempts a JOIN requests r ON r.id=a.request_id WHERE ${where} GROUP BY a.provider_id`).all(...args);
    for (const key of ['requests', 'success', 'running', 'active_users', 'attempts', 'retries', 'first_success', 'unknown_usage', 'missing_success', 'missing_failed', 'pending_usage']) totals[key] = Number(totals[key] ?? 0);
    return { ...totals, daily, providers, since };
  }
  saveVersion(actor: string, label: string) {
    const versionId = id('version');
    this.db.prepare('INSERT INTO config_versions VALUES(?,?,?,?,?)').run(versionId, Date.now(), actor, label, JSON.stringify({ providers: this.providers(), models: this.models() }));
    return versionId;
  }
  versions() { return this.db.prepare('SELECT id,created_at,actor,label FROM config_versions ORDER BY created_at DESC LIMIT 30').all(); }
  restoreVersion(versionId: string) {
    const row = this.db.prepare('SELECT snapshot FROM config_versions WHERE id=?').get(versionId) as Row | undefined;
    if (!row) throw new Error('配置版本不存在');
    const snapshot = JSON.parse(row.snapshot) as { providers: Provider[]; models: Model[] };
    this.transaction(() => {
      for (const p of this.providers()) if (!snapshot.providers.some(x => x.id === p.id)) this.saveProvider({ ...p, enabled: false });
      for (const m of this.models()) if (!snapshot.models.some(x => x.id === m.id)) this.saveModel({ ...m, enabled: false });
      snapshot.providers.forEach(p => this.saveProvider(p));
      // Restoring routing/capability history must not resurrect old access grants.
      snapshot.models.forEach(m => this.saveModel({ ...m, audience: this.model(m.id)?.audience ?? { type: 'selected', userIds: [] } }));
    });
  }
}
