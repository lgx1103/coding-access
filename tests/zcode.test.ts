import { afterEach, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parse } from 'jsonc-parser';
import { atomicWrite, ConfigManager } from '../src/desktop/config.js';
import { findTool } from '../src/desktop/launch.js';
import { createApp } from '../src/server/app.js';
import { fixture, completion, chatSSE, textChunks } from './helpers.js';
import type { EmployeeModel } from '../src/shared/types.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
const model: EmployeeModel = { id: 'glm-company', name: 'GLM 公司模型', description: '', contextWindow: 1000000, maxOutputTokens: 8192, agents: ['zcode'], vision: true, status: 'available', updatedAt: Date.now() };
function config() {
  const root = mkdtempSync(join(tmpdir(), 'zcode-config-test-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return new ConfigManager(join(root, 'home'), join(root, 'state'), {});
}
test('ZCode merges a dedicated provider, preserves other tools and restores the original bytes', () => {
  const manager = config();
  const original = '{\n // My providers\n "provider":{"personal":{"kind":"openai-compatible","options":{"apiKey":"personal-key"}}},"model":{"main":"personal/old"}\n}\n';
  atomicWrite(manager.path('zcode'), original);
  atomicWrite(manager.path('codex-cli'), 'model="untouched"\n');
  atomicWrite(manager.path('claude-code'), '{"theme":"dark"}\n');
  manager.apply('zcode', model, 'https://gateway.test/', 'company-token', 'company-credential');
  const written = readFileSync(manager.path('zcode'), 'utf8'); const data = parse(written);
  expect(written).toContain('// My providers');
  expect(data.provider.personal.options.apiKey).toBe('personal-key');
  expect(data.model.main).toBe('personal/old');
  expect(data.provider.coding_access).toMatchObject({ kind: 'anthropic', enabled: true, options: { apiKey: 'company-token', baseURL: 'https://gateway.test' }, headers: { 'x-coding-agent': 'zcode' } });
  expect(data.provider.coding_access.models[model.id]).toMatchObject({ name: model.name, limit: { context: 1000000, output: 8192 }, modalities: { input: ['text', 'image'], output: ['text'] }, zcode: { modalitiesConfigured: true } });
  expect(manager.configured().zcode?.modelId).toBe(model.id);
  expect(manager.configured()['codex-cli']).toBeUndefined();
  manager.restore('zcode'); expect(readFileSync(manager.path('zcode'), 'utf8')).toBe(original);
  expect(readFileSync(manager.path('codex-cli'), 'utf8')).toBe('model="untouched"\n');
  expect(readFileSync(manager.path('claude-code'), 'utf8')).toBe('{"theme":"dark"}\n');
});
test('switching ZCode models removes stale managed capabilities and retains the first backup', () => {
  const manager = config();
  manager.apply('zcode', model, 'https://gateway.test', 'company-token', 'cred');
  manager.apply('zcode', { ...model, id: 'unknown', contextWindow: undefined, maxOutputTokens: undefined, vision: undefined }, 'https://gateway.test', 'company-token', 'cred');
  const data = parse(readFileSync(manager.path('zcode'), 'utf8'));
  expect(Object.keys(data.provider.coding_access.models)).toEqual(['unknown']);
  expect(data.provider.coding_access.models.unknown).not.toHaveProperty('limit');
  expect(data.provider.coding_access.models.unknown).not.toHaveProperty('modalities');
  expect(data).not.toHaveProperty('model');
  manager.restore('zcode'); expect(existsSync(manager.path('zcode'))).toBe(false);
});
test('ZCode malformed or externally modified configurations are preserved', () => {
  const manager = config(); atomicWrite(manager.path('zcode'), '{"provider":[]}');
  expect(() => manager.apply('zcode', model, 'https://gateway.test', 'token', 'cred')).toThrow('provider');
  expect(readFileSync(manager.path('zcode'), 'utf8')).toBe('{"provider":[]}');
  atomicWrite(manager.path('zcode'), '{}'); manager.apply('zcode', model, 'https://gateway.test', 'token', 'cred');
  atomicWrite(manager.path('zcode'), '{"provider":{"changed":{}}}');
  expect(() => manager.apply('zcode', model, 'https://gateway.test', 'token', 'cred')).toThrow('其他程序');
  expect(() => manager.restore('zcode')).toThrow('其他程序');
});
test('ZCode startup normalization allows reapply and preserves new providers during restore', () => {
  const manager = config();
  manager.apply('zcode', model, 'https://gateway.test', 'company-token', 'cred');
  const normalized = parse(readFileSync(manager.path('zcode'), 'utf8'));
  normalized.provider.coding_access.source = 'custom';
  normalized.provider.coding_access.models[model.id].reasoning = { enabled: true, variants: ['low', 'high', 'max'], defaultVariant: 'max' };
  normalized.provider['builtin:bigmodel'] = { source: 'builtin', enabled: false };
  normalized.personalSetting = 'keep';
  atomicWrite(manager.path('zcode'), '// Added after startup\n' + JSON.stringify(normalized, null, 2));
  expect(manager.warnings('zcode').some(w => w.includes('已暂停'))).toBe(false);
  manager.apply('zcode', model, 'https://gateway.test', 'company-token', 'cred');
  expect(parse(readFileSync(manager.path('zcode'), 'utf8')).provider.coding_access.models[model.id].reasoning).toEqual(normalized.provider.coding_access.models[model.id].reasoning);
  manager.restore('zcode');
  const restored = readFileSync(manager.path('zcode'), 'utf8');
  expect(restored).toContain('// Added after startup');
  expect(parse(restored)).toEqual({ provider: { 'builtin:bigmodel': { source: 'builtin', enabled: false } }, personalSetting: 'keep' });
});
test('ZCode scoped restore retains unrelated changes and restores a previous company provider', () => {
  const manager = config(); const original = { provider: { coding_access: { kind: 'anthropic', options: { apiKey: 'previous-token' } } } };
  atomicWrite(manager.path('zcode'), JSON.stringify(original));
  manager.apply('zcode', model, 'https://gateway.test', 'company-token', 'cred');
  const external = parse(readFileSync(manager.path('zcode'), 'utf8')); external.provider.personal = { name: 'New personal provider' };
  atomicWrite(manager.path('zcode'), JSON.stringify(external));
  manager.restore('zcode');
  expect(parse(readFileSync(manager.path('zcode'), 'utf8')).provider).toEqual({ ...original.provider, personal: external.provider.personal });
});
test('ZCode provider credentials and routing changes still block both reapply and restore', () => {
  const manager = config(); manager.apply('zcode', model, 'https://gateway.test', 'company-token', 'cred');
  const external = parse(readFileSync(manager.path('zcode'), 'utf8')); external.provider.coding_access.options.baseURL = 'https://personal.test';
  atomicWrite(manager.path('zcode'), JSON.stringify(external));
  expect(() => manager.apply('zcode', model, 'https://gateway.test', 'company-token', 'cred')).toThrow('其他程序');
  expect(() => manager.restore('zcode')).toThrow('其他程序');
  expect(parse(readFileSync(manager.path('zcode'), 'utf8')).provider.coding_access.options.baseURL).toBe('https://personal.test');
});
test('ZCode uses its official data base override and detects a user-installed desktop app', () => {
  const manager = config(); const custom = new ConfigManager(manager.home, manager.stateDirectory, { ZCODE_DATA_BASE_DIR: join(manager.home, 'isolated') });
  expect(custom.path('zcode')).toBe(join(manager.home, 'isolated/.zcode/v2/config.json'));
  const app = join(manager.home, 'Applications/ZCode.app'); mkdirSync(app, { recursive: true });
  // A system installation may also exist on the test host; either is a valid desktop app.
  expect(basename(findTool('zcode', manager.home, {}, 'darwin')!)).toBe('ZCode.app');
  expect(manager.warnings('zcode')).toContain('请先完全退出 ZCode 再应用或恢复配置。重新打开后，在模型选择器中选择 Coding Access 下的模型；已有会话不会自动切换。');
});
async function server(stream = false) {
  const f = await fixture(); f.store.saveModel({ ...f.model, agents: ['zcode'] });
  const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'https://company.test', gateway: { fetch: async () => stream ? chatSSE(textChunks()) : Response.json(completion()) } });
  cleanup.push(async () => { await app.close(); f.store.close(); }); return { ...f, app };
}
test('ZCode requests enforce their own tool permission and retain independent attribution', async () => {
  const f = await server();
  const payload = { model: f.model.id, max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] };
  const headers = { 'x-api-key': f.apiKey, 'x-coding-agent': 'zcode' };
  expect((await f.app.inject({ method: 'POST', url: '/v1/messages', headers, payload })).statusCode).toBe(200);
  expect(f.store.requests()[0].agent).toBe('zcode');
  expect((await f.app.inject({ method: 'POST', url: '/v1/messages', headers: { 'x-api-key': f.apiKey }, payload })).json().error.code).toBe('agent_not_enabled');
  expect((await f.app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${f.apiKey}` }, payload: { model: f.model.id, input: 'hello' } })).json().error.code).toBe('agent_not_enabled');
  const token = f.store.issue(f.employee.id, 'session', 'device').token;
  const credential = f.store.authenticate(f.apiKey, 'api')!;
  const url = `/api/me/credential-status?credentialId=${credential.credentialId}&modelId=${f.model.id}&agent=`;
  for (const agent of ['claude-code', 'codex-cli', 'codex-desktop']) expect((await f.app.inject({ url: url + agent, headers: { authorization: `Bearer ${token}` } })).json().request).toBeNull();
  expect((await f.app.inject({ url: url + 'zcode', headers: { authorization: `Bearer ${token}` } })).json().request.agent).toBe('zcode');
});
test('ZCode catalog filters other tools and management accepts ZCode-only models', async () => {
  const f = await server();
  f.store.saveModel({ ...f.model, id: 'claude-only', agents: ['claude-code'] });
  f.store.saveUser({ ...f.employee, models: [f.model.id, 'claude-only'] });
  const list = await f.app.inject({ url: '/v1/models', headers: { 'x-api-key': f.apiKey, 'x-coding-agent': 'zcode' } });
  expect(list.json().data.map((m: any) => m.id)).toEqual([f.model.id]);
  const created = await f.app.inject({ method: 'POST', url: '/api/admin/models', headers: { authorization: `Bearer ${f.adminSession}` }, payload: { name: 'ZCode pool', agents: ['zcode'], routes: f.model.routes } });
  expect(created.statusCode).toBe(201); expect(created.json().model.agents).toEqual(['zcode']);
});
test('ZCode key checks use Messages and are logged as ZCode', async () => {
  const f = await server(true);
  const checked = await f.app.inject({ method: 'POST', url: `/api/admin/keys/${f.keys[0].id}/check`, headers: { authorization: `Bearer ${f.adminSession}` }, payload: { modelId: f.model.id, agent: 'zcode' } });
  expect(checked.statusCode).toBe(200); expect(checked.json().ok).toBe(true);
  expect(f.store.requests()[0].agent).toBe('zcode');
});
