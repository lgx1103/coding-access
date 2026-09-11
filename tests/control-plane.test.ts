import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/db.js';
import { chatSSE, completion, fixture, textChunks } from './helpers.js';
const cleanups: (() => Promise<void> | void)[] = []; afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

test('creating models generates unique IDs without overwriting an existing model or requiring capability guesses', async () => {
  const f = await fixture(); cleanups.push(() => f.store.close());
  const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'https://company.test' }); cleanups.push(() => app.close());
  const headers = { authorization: `Bearer ${f.adminSession}` };
  const payload = { name: 'GLM Test', agents: ['codex-cli'], routes: [{ providerId: 'zhipu', upstreamModel: 'vendor-next', weight: 1 }] };
  const responses = await Promise.all([payload, { ...payload, id: 'glm-test' }].map(body => app.inject({ method: 'POST', url: '/api/admin/models', headers, payload: body })));
  expect(responses.map(response => response.statusCode)).toEqual([201, 201]);
  const created = responses.map(response => response.json().model);
  expect(new Set(created.map(model => model.id))).toEqual(new Set(['glm-test-2', 'glm-test-3']));
  expect(f.store.model(f.model.id)).toEqual(f.model);
  expect(f.store.user(f.employee.id)?.models).toEqual(['glm-test']);
  for (const model of created) {
    expect(model.description).toBe(''); expect(model.enabled).toBe(false);
    expect(model).not.toHaveProperty('contextWindow'); expect(model).not.toHaveProperty('maxOutputTokens');
    expect(model.routes[0]).not.toHaveProperty('vision'); expect(model.routes[0]).not.toHaveProperty('contextWindow');
  }
});

test('Chinese and long duplicate names receive valid distinct internal IDs', async () => {
  const f = await fixture(); cleanups.push(() => f.store.close());
  const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'https://company.test' }); cleanups.push(() => app.close());
  const headers = { authorization: `Bearer ${f.adminSession}` };
  const ids: string[] = [];
  for (const name of ['公司编程模型', '公司编程模型', 'A'.repeat(100), 'A'.repeat(100)]) {
    const response = await app.inject({ method: 'POST', url: '/api/admin/models', headers, payload: { name, agents: ['claude-code'], routes: [f.model.routes[0]] } });
    expect(response.statusCode).toBe(201); const model = response.json().model;
    expect(model.name).toBe(name); expect(model.id).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/); ids.push(model.id);
  }
  expect(ids[0]).toMatch(/^model-/); expect(ids[1]).toMatch(/^model-/); expect(new Set(ids).size).toBe(4);
});

test('renaming preserves the ID, employee access, key restrictions and past request references', async () => {
  const f = await fixture(); cleanups.push(() => f.store.close());
  const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'https://company.test', gateway: { fetch: async () => Response.json(completion()) } }); cleanups.push(() => app.close());
  f.store.saveKey({ ...f.keys[0], models: [f.model.id] });
  const requestId = f.store.beginRequest(f.employee.id, f.model.id, 'codex'); f.store.finishRequest(requestId, 'success');
  const headers = { authorization: `Bearer ${f.adminSession}` };
  const updated = await app.inject({ method: 'PUT', url: `/api/admin/models/${f.model.id}`, headers, payload: { ...f.model, name: '新的员工可见名称' } });
  expect(updated.statusCode).toBe(200); expect(updated.json().model).toMatchObject({ id: f.model.id, name: '新的员工可见名称', createdAt: f.model.createdAt });
  expect(f.store.models()).toHaveLength(1); expect(f.store.user(f.employee.id)?.models).toEqual([f.model.id]); expect(f.store.key(f.keys[0].id)?.models).toEqual([f.model.id]);
  expect(f.store.requests({ modelId: f.model.id })[0]).toMatchObject({ id: requestId, model_id: f.model.id });
  const invoke = await app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${f.apiKey}` }, payload: { model: f.model.id, input: 'hello' } });
  expect(invoke.statusCode).toBe(200); expect(invoke.json().model).toBe(f.model.id);
  const changedId = await app.inject({ method: 'PUT', url: `/api/admin/models/${f.model.id}`, headers, payload: { ...f.model, id: 'replacement-id' } });
  expect(changedId.statusCode).toBe(400); expect(changedId.json().error.code).toBe('immutable_model_id'); expect(f.store.model('replacement-id')).toBeUndefined();
});

test('model creation requires an administrator and validates provider references before saving', async () => {
  const f = await fixture(); cleanups.push(() => f.store.close());
  const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'https://company.test' }); cleanups.push(() => app.close());
  const payload = { name: 'A model', agents: ['codex-cli'], routes: [f.model.routes[0]] };
  const token = f.store.issue(f.employee.id, 'session', 'browser').token;
  expect((await app.inject({ method: 'POST', url: '/api/admin/models', payload })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/admin/models', headers: { authorization: `Bearer ${token}` }, payload })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/api/admin/models', headers: { authorization: `Bearer ${f.apiKey}` }, payload })).statusCode).toBe(401);
  const response = await app.inject({ method: 'POST', url: '/api/admin/models', headers: { authorization: `Bearer ${f.adminSession}` }, payload: { ...payload, routes: [{ ...f.model.routes[0], providerId: 'absent' }] } });
  expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe('provider_not_found');
  expect(f.store.models()).toEqual([f.model]); expect(f.store.versions()).toHaveLength(0);
});

test('automatic capabilities use trusted profiles while unknown, manual and legacy models keep their meaning', async () => {
  const f = await fixture(); cleanups.push(() => f.store.close());
  f.store.saveProvider({ ...f.providers[0], endpoints: { chat: 'https://open.bigmodel.cn/api/coding/paas/v4' } });
  const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'https://company.test' }); cleanups.push(() => app.close());
  const headers = { authorization: `Bearer ${f.adminSession}` };
  const payload = { name: 'GLM 5.3', capabilityMode: 'automatic', agents: ['codex-cli'], contextWindow: 128000, maxOutputTokens: 8192, routes: [{ providerId: 'zhipu', upstreamModel: 'glm-5.3', weight: 1, contextWindow: 128000, vision: true }] };
  const response = await app.inject({ method: 'POST', url: '/api/admin/models', headers, payload });
  expect(response.statusCode).toBe(201); const created = response.json().model;
  expect(created).toMatchObject({ contextWindow: 1000000, maxOutputTokens: 131072, routes: [{ contextWindow: 1000000, vision: false }] });
  const update = { ...payload, id: created.id, routes: [{ ...payload.routes[0], upstreamModel: 'custom-unknown' }] };
  const unknown = await app.inject({ method: 'PUT', url: `/api/admin/models/${created.id}`, headers, payload: update });
  expect(unknown.statusCode).toBe(200); const unknownModel = unknown.json().model;
  expect(unknownModel).not.toHaveProperty('contextWindow'); expect(unknownModel).not.toHaveProperty('maxOutputTokens');
  expect(unknownModel.routes[0]).not.toHaveProperty('contextWindow'); expect(unknownModel.routes[0]).not.toHaveProperty('vision');
  const manual = await app.inject({ method: 'PUT', url: `/api/admin/models/${created.id}`, headers, payload: { ...update, capabilityMode: 'manual' } });
  expect(manual.json().model).toMatchObject({ contextWindow: 128000, maxOutputTokens: 8192, routes: [{ contextWindow: 128000, vision: true }] });
  const legacy = await app.inject({ method: 'PUT', url: `/api/admin/models/${f.model.id}`, headers, payload: { ...f.model, name: '改名后的旧模型' } });
  expect(legacy.json().model).toMatchObject({ contextWindow: f.model.contextWindow, maxOutputTokens: f.model.maxOutputTokens, routes: f.model.routes });
  expect(legacy.json().model).not.toHaveProperty('capabilityMode');
});

test('connection checks use a small explicit output request when the model maximum is unknown', async () => {
  const f = await fixture(); cleanups.push(() => f.store.close()); const outputs: number[] = [];
  f.store.saveModel({ ...f.model, maxOutputTokens: undefined });
  const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'https://company.test', gateway: { fetch: async (_, init) => { outputs.push(JSON.parse(String(init?.body)).max_tokens); return chatSSE(textChunks()); } } }); cleanups.push(() => app.close());
  const response = await app.inject({ method: 'POST', url: `/api/admin/keys/${f.keys[0].id}/check`, headers: { authorization: `Bearer ${f.adminSession}` }, payload: { modelId: f.model.id, agent: 'codex-cli' } });
  expect(response.statusCode).toBe(200); expect(response.json().ok).toBe(true); expect(outputs).toEqual([64]);
});

test('model pools reject mixed known variants in automatic, manual and legacy saves without changing existing records', async () => {
  const f = await fixture(); cleanups.push(() => f.store.close());
  f.store.saveProvider({ ...f.providers[0], endpoints: { chat: 'https://open.bigmodel.cn/api/coding/paas/v4' } });
  f.store.saveProvider({ ...f.providers[1], endpoints: { chat: 'https://ark.cn-beijing.volces.com/api/coding/v3' } });
  f.store.saveProvider({ ...f.providers[1], id: 'deepseek', endpoints: { chat: 'https://api.deepseek.com/v1' } });
  const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'https://company.test' }); cleanups.push(() => app.close());
  const headers = { authorization: `Bearer ${f.adminSession}` };
  for (const second of [{ providerId: 'volcano', upstreamModel: 'glm-5.3-flash' }, { providerId: 'deepseek', upstreamModel: 'deepseek-v4-pro' }]) {
    for (const capabilityMode of ['automatic', 'manual', undefined]) {
      const payload = { ...f.model, capabilityMode, routes: [{ providerId: 'zhipu', upstreamModel: 'GLM-5.3', weight: 2 }, { ...second, weight: 1 }] };
      for (const method of ['POST', 'PUT'] as const) {
        const response = await app.inject({ method, url: `/api/admin/models${method === 'PUT' ? `/${f.model.id}` : ''}`, headers, payload });
        expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe('mixed_model_pool');
      }
    }
  }
  expect(f.store.models()).toEqual([f.model]); expect(f.store.versions()).toHaveLength(0);
});

test('model pools accept the same known model, unknown deployment IDs, and compatible manual configuration', async () => {
  const f = await fixture(); cleanups.push(() => f.store.close());
  f.store.saveProvider({ ...f.providers[0], endpoints: { chat: 'https://open.bigmodel.cn/api/coding/paas/v4' } });
  f.store.saveProvider({ ...f.providers[1], endpoints: { chat: 'https://ark.cn-beijing.volces.com/api/coding/v3' } });
  const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'https://company.test' }); cleanups.push(() => app.close());
  const headers = { authorization: `Bearer ${f.adminSession}` };
  for (const [capabilityMode, upstreamModel] of [['automatic', 'glm-5.3'], ['automatic', 'private-deployment'], ['manual', 'glm-5.3']]) {
    const response = await app.inject({ method: 'POST', url: '/api/admin/models', headers, payload: { name: 'GLM 5.3', agents: ['codex-cli'], capabilityMode, routes: [{ providerId: 'zhipu', upstreamModel: 'glm-5.3', weight: 2 }, { providerId: 'volcano', upstreamModel, weight: 1 }] } });
    expect(response.statusCode).toBe(201);
  }
  expect(f.store.models()).toHaveLength(4);
});

test('automatic model reads follow current provider capabilities across endpoint changes and restore', async () => {
  const f = await fixture(); cleanups.push(() => f.store.close());
  const official = { ...f.providers[0], endpoints: { chat: 'https://open.bigmodel.cn/api/coding/paas/v4' } };
  f.store.saveProvider(official);
  f.store.saveModel({ ...f.model, capabilityMode: 'automatic', routes: [{ ...f.model.routes[0], upstreamModel: 'glm-5.3' }] });
  const raw = () => f.store.db.prepare('SELECT data FROM models WHERE id=?').get(f.model.id)?.data;
  const originalStoredModel = raw();
  const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'https://company.test', gateway: { fetch: async () => Response.json(completion()) } }); cleanups.push(() => app.close());
  const employeeSession = f.store.issue(f.employee.id, 'session', 'desktop').token;
  const adminModels = async () => (await app.inject({ url: '/api/admin/models', headers: { authorization: `Bearer ${f.adminSession}` } })).json().models;
  const catalog = async () => (await app.inject({ url: '/api/models?agent=codex-cli', headers: { authorization: `Bearer ${employeeSession}` } })).json().models;
  expect(f.store.model(f.model.id)).toMatchObject({ contextWindow: 1000000, maxOutputTokens: 131072, routes: [{ contextWindow: 1000000, vision: false }] });
  expect((await adminModels())[0].contextWindow).toBe(1000000); expect((await catalog())[0].maxOutputTokens).toBe(131072);
  const version = f.store.saveVersion(f.admin.id, 'official endpoint');
  const invoke = () => app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${f.apiKey}` }, payload: { model: f.model.id, input: 'hello', max_output_tokens: 200000 } });
  expect((await invoke()).statusCode).toBe(400);
  f.store.saveProvider({ ...official, endpoints: { chat: 'https://custom-provider.test/v1' } });
  expect(f.store.model(f.model.id)?.contextWindow).toBeUndefined(); expect(f.store.models()[0].maxOutputTokens).toBeUndefined();
  for (const model of [...await adminModels(), ...await catalog()]) {
    expect(model).not.toHaveProperty('contextWindow'); expect(model).not.toHaveProperty('maxOutputTokens');
  }
  expect((await invoke()).statusCode).toBe(200);
  expect(raw()).toBe(originalStoredModel);
  f.store.saveProvider(official);
  expect((await catalog())[0]).toMatchObject({ contextWindow: 1000000, maxOutputTokens: 131072, vision: false });
  expect(raw()).toBe(originalStoredModel);
  f.store.saveProvider({ ...official, endpoints: { chat: 'https://custom-provider.test/v1' } });
  f.store.restoreVersion(version);
  expect(f.store.provider(official.id)).toEqual(official);
  expect(f.store.model(f.model.id)).toMatchObject({ contextWindow: 1000000, maxOutputTokens: 131072 });
});

test('provider endpoint changes preserve manual overrides and legacy model capacities', async () => {
  const f = await fixture(); cleanups.push(() => f.store.close());
  const legacy = { ...f.model, routes: [{ ...f.model.routes[0], upstreamModel: 'glm-5.3' }] };
  const manual = { ...legacy, id: 'glm-manual', capabilityMode: 'manual' as const };
  f.store.saveModel(legacy); f.store.saveModel(manual);
  for (const chat of ['https://open.bigmodel.cn/api/coding/paas/v4', 'https://custom-provider.test/v1']) {
    f.store.saveProvider({ ...f.providers[0], endpoints: { chat } });
    expect(f.store.model(legacy.id)).toEqual(legacy); expect(f.store.model(manual.id)).toEqual(manual);
    expect(f.store.models()).toEqual([legacy, manual]);
  }
});

test('new models and provider Key rotation work with the same employee credential', async () => {
  const f = await fixture(); cleanups.push(() => f.store.close()); const used: string[] = [];
  const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'https://company.test', gateway: { fetch: async (_, options) => { used.push(new Headers(options?.headers).get('authorization')!); return Response.json(completion()); } } }); cleanups.push(() => app.close());
  const headers = { authorization: `Bearer ${f.adminSession}` }; const employeeSession = f.store.issue(f.employee.id, 'session', 'desktop').token;
  const model = { ...f.model, id: 'glm-next', name: 'GLM Next', routes: [f.model.routes[0]] };
  expect((await app.inject({ method: 'POST', url: '/api/admin/models', headers, payload: { ...model, enabled: false, audience: { type: 'selected', userIds: [] } } })).statusCode).toBe(201);
  const catalog = () => app.inject({ url: '/api/models?agent=codex-cli', headers: { authorization: `Bearer ${employeeSession}` } });
  expect((await catalog()).json().models.some((m: any) => m.id === 'glm-next')).toBe(false);
  expect((await app.inject({ method: 'PUT', url: '/api/admin/models/glm-next', headers, payload: model })).statusCode).toBe(200); expect((await catalog()).json().models.some((m: any) => m.id === 'glm-next')).toBe(true);
  f.store.saveKey({ ...f.keys[1], enabled: false }); f.store.block('invalid:z1', Date.now() + 60000, 'invalid_api_key');
  const { encryptedSecret: _, secretHash: __, providerId: ___, ...key } = f.keys[0];
  expect((await app.inject({ method: 'PUT', url: '/api/admin/keys/z1', headers, payload: { ...key, secret: 'rotated-vendor-key' } })).statusCode).toBe(200);
  const invoke = () => app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${f.apiKey}` }, payload: { model: 'glm-next', input: 'hello' } });
  expect((await invoke()).statusCode).toBe(200); expect(used).toEqual(['Bearer rotated-vendor-key']);
  await app.inject({ method: 'PUT', url: '/api/admin/models/glm-next', headers, payload: { ...model, enabled: false } });
  expect((await invoke()).statusCode).toBe(403); expect(used).toHaveLength(1);
});

test('deletion guards active resources, preserves history and never restores employee permissions', async () => {
  const f = await fixture(); cleanups.push(() => f.store.close()); const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'https://company.test' }); cleanups.push(() => app.close());
  const headers = { authorization: `Bearer ${f.adminSession}` };
  expect((await app.inject({ method: 'DELETE', url: '/api/admin/models/glm-test', headers })).statusCode).toBe(409);
  const req = f.store.beginRequest(f.employee.id, 'glm-test', 'codex'); f.store.finishRequest(req, 'success'); f.store.saveModel({ ...f.model, enabled: false });
  const version = f.store.saveVersion(f.admin.id, 'before removal');
  expect((await app.inject({ method: 'DELETE', url: '/api/admin/models/glm-test', headers })).statusCode).toBe(200);
  expect(f.store.requests()).toHaveLength(1); expect(f.store.user(f.employee.id)?.models).toEqual([]);
  f.store.revoke(f.employee.id); f.store.restoreVersion(version); expect(f.store.user(f.employee.id)?.models).toEqual([]); expect(f.store.authenticate(f.apiKey, 'api')).toBeUndefined();
  f.store.saveProvider({ ...f.providers[0], enabled: false }); expect((await app.inject({ method: 'DELETE', url: '/api/admin/providers/zhipu', headers })).statusCode).toBe(409);
  f.store.saveKey({ ...f.keys[0], enabled: false }); expect((await app.inject({ method: 'DELETE', url: '/api/admin/keys/z1', headers })).statusCode).toBe(200); expect(f.store.key('z1')).toBeUndefined();
});

test('restart keeps cooldown and revoked credentials; interrupted work remains uncertain', async () => {
  const f = await fixture(); const dir = mkdtempSync(join(tmpdir(), 'aca-restart-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite'); const until = Date.now() + 60000; f.store.block('key:z1', until, 'rate_limit'); f.store.revoke(f.employee.id);
  const requestId = f.store.beginRequest(f.employee.id, 'glm-test', 'codex'); f.store.attempt({ id: 'pending', requestId, providerId: 'zhipu', keyId: 'z1', startedAt: Date.now(), status: 'running', input: null, output: null, cached: null });
  f.store.db.prepare('VACUUM INTO ?').run(path); f.store.close(); const restarted = new Store(path); cleanups.push(() => restarted.close());
  expect(restarted.blocked(f.keys[0], 'glm-test')?.until_ms).toBe(until); expect(restarted.authenticate(f.apiKey, 'api')).toBeUndefined();
  expect(restarted.requests()[0]).toMatchObject({ status: 'interrupted' }); expect(restarted.attempts(requestId)[0]).toMatchObject({ ambiguous: 1, input_tokens: null });
});
