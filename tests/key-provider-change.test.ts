import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.js';
import { completion, fixture } from './helpers.js';
import type { ApiKey } from '../src/shared/types.js';

function edit(key: ApiKey, providerId?: string) {
  const { name, enabled, models, maxConcurrent, weight, rateScope, group } = key;
  return { name, enabled, models, maxConcurrent, weight, rateScope, group, ...(providerId ? { providerId } : {}) };
}

test('moving an idle key preserves its secret/settings and history, and routes new calls to the target provider', async () => {
  const f = await fixture();
  const calls: string[] = [];
  const { app, gateway } = await createApp({ store: f.store, box: f.box, publicUrl: 'http://localhost', gateway: { fetch: async url => { calls.push(String(url)); return Response.json(completion()); } } });
  const key = { ...f.keys[0], models: [f.model.id], weight: 3, rateScope: 'group' as const, group: 'team' };
  f.store.saveKey(key);
  const headers = { authorization: `Bearer ${f.adminSession}` };
  try {
    await gateway.execute(f.apiKey, { model: f.model.id, messages: [{ role: 'user', content: 'hello' }] }, 'chat', 'codex-cli', undefined, {}, key.id);
    expect(f.store.lastSuccess(key.id)).toBeDefined();
    const oldAttempts = f.store.db.prepare('SELECT * FROM attempts').all();
    for (const scope of [`invalid:${key.id}`, `key:${key.id}`, `key-model:${key.id}:${f.model.id}`, 'provider:zhipu', 'group:zhipu:team', 'key:z2']) f.store.block(scope, Date.now() + 60000, 'old-limit');
    f.store.db.prepare('INSERT INTO response_routes VALUES(?,?,?,?,?)').run('old-response', f.employee.id, f.model.id, key.id, Date.now());
    const result = await app.inject({ method: 'PUT', url: `/api/admin/keys/${key.id}`, headers, payload: edit(key, 'volcano') });
    expect(result.statusCode).toBe(200);
    expect(f.store.key(key.id)).toEqual({ ...key, providerId: 'volcano' });
    expect(result.json().key).not.toHaveProperty('encryptedSecret');
    expect(result.json().key.lastSuccess).toBeNull();
    expect(f.store.blocked(f.store.key(key.id)!, f.model.id)).toBeUndefined();
    expect(f.store.db.prepare('SELECT scope FROM states ORDER BY scope').all().map(row => row.scope)).toEqual(['group:zhipu:team', 'key:z2', 'provider:zhipu']);
    expect(f.store.db.prepare('SELECT * FROM response_routes WHERE key_id=?').all(key.id)).toEqual([]);
    expect(f.store.db.prepare('SELECT * FROM attempts').all()).toEqual(oldAttempts);
    expect(f.store.requests({ providerId: 'zhipu' })).toHaveLength(1);
    expect(f.store.requests({ providerId: 'volcano' })).toHaveLength(0);
    await gateway.execute(f.apiKey, { model: f.model.id, messages: [{ role: 'user', content: 'hello' }] }, 'chat', 'codex-cli', undefined, {}, key.id);
    expect(calls).toEqual(['https://zhipu.test/v1/chat/completions', 'https://volcano.test/v1/chat/completions']);
    expect(f.store.requests({ providerId: 'zhipu' })).toHaveLength(1);
    expect(f.store.requests({ providerId: 'volcano' })).toHaveLength(1);
    const audit = f.store.db.prepare("SELECT details FROM audit WHERE action='key_updated'").get()!;
    expect(JSON.parse(String(audit.details))).toEqual({ previousProviderId: 'zhipu', providerId: 'volcano' });
  } finally { await app.close(); f.store.close(); }
});

test('moving a key respects active requests and authorization; unchanged/legacy edits keep recovery state', async () => {
  const f = await fixture();
  const { app, gateway } = await createApp({ store: f.store, box: f.box, publicUrl: 'http://localhost' });
  const key = f.keys[0]; const headers = { authorization: `Bearer ${f.adminSession}` };
  const lease = gateway.pool.acquire([{ id: key.id, providerId: key.providerId, keyWeight: 1, providerWeight: 1, maxConcurrent: 2 }])!;
  const save = (payload: object, auth = headers) => app.inject({ method: 'PUT', url: `/api/admin/keys/${key.id}`, headers: auth, payload });
  try {
    f.store.block(`key:${key.id}`, Date.now() + 60000, 'rate_limit');
    f.store.success(key);
    expect((await save(edit(key, 'volcano'))).statusCode).toBe(409);
    expect(f.store.key(key.id)).toEqual(key);
    expect((await save(edit(key, key.providerId))).statusCode).toBe(200);
    expect((await save(edit(key))).statusCode).toBe(200);
    expect(f.store.blocked(key, f.model.id)).toBeDefined();
    expect(f.store.lastSuccess(key.id)).toBeDefined();
    lease.release();
    expect((await save(edit(key, 'missing'))).statusCode).toBe(400);
    expect((await save(edit(key, 'volcano'), { authorization: '' })).statusCode).toBe(401);
    const employeeSession = f.store.issue(f.employee.id, 'session', 'test').token;
    expect((await save(edit(key, 'volcano'), { authorization: `Bearer ${employeeSession}` })).statusCode).toBe(403);
    expect(f.store.key(key.id)).toEqual(key);
    // The destination's shared cooldown remains effective for a moved key.
    f.store.block('provider:volcano', Date.now() + 60000, 'service_unavailable');
    expect((await save(edit(key, 'volcano'))).statusCode).toBe(200);
    expect(f.store.blocked(f.store.key(key.id)!, f.model.id)?.scope).toBe('provider:volcano');
  } finally { lease.release(); await app.close(); f.store.close(); }
});

test('key state cleanup treats wildcard characters in IDs literally', async () => {
  const f = await fixture();
  try {
    const key = { ...f.keys[0], id: 'key_1' };
    f.store.block('key-model:key_1:m', Date.now() + 60000, 'rate_limit');
    f.store.block('key-model:keyX1:m', Date.now() + 60000, 'rate_limit');
    f.store.resetKeyBinding(key);
    expect(f.store.db.prepare('SELECT scope FROM states').all().map(row => row.scope)).toEqual(['key-model:keyX1:m']);
  } finally { f.store.close(); }
});
