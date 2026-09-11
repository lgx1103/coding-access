import { SecretBox, digest, hashPassword, id } from '../src/server/security.js';
import { Store, type User } from '../src/server/db.js';
import type { ApiKey, Model, Provider } from '../src/shared/types.js';

export async function fixture() {
  const store = new Store(':memory:'); const box = new SecretBox(Buffer.alloc(32, 7).toString('base64'));
  const hash = await hashPassword('TestPassword123!');
  const admin: User = { id: 'admin', username: 'admin', name: '管理员', passwordHash: hash, role: 'admin', enabled: true, mustChangePassword: false, models: [], createdAt: Date.now() };
  const employee: User = { ...admin, id: 'employee', username: 'employee', name: '开发同事', role: 'employee', models: ['glm-test'] };
  store.saveUser(admin); store.saveUser(employee);
  const providers: Provider[] = [
    { id: 'zhipu', name: '智谱', product: 'Coding Plan', enabled: true, endpoints: { chat: 'https://zhipu.test/v1' }, auth: 'bearer', headers: {}, defaults: {}, createdAt: Date.now() },
    { id: 'volcano', name: '火山', product: 'Coding Plan', enabled: true, endpoints: { chat: 'https://volcano.test/v1' }, auth: 'bearer', headers: {}, defaults: {}, createdAt: Date.now() },
  ];
  providers.forEach(p => store.saveProvider(p));
  const keys: ApiKey[] = ['z1', 'z2', 'v1'].map(keyId => ({ id: keyId, providerId: keyId.startsWith('z') ? 'zhipu' : 'volcano', name: keyId, enabled: true, secretHash: digest(`vendor-secret-${keyId}`), encryptedSecret: box.seal(`vendor-secret-${keyId}`), hint: `••${keyId}`, models: [], maxConcurrent: 2, weight: 1, rateScope: 'key', group: '', createdAt: Date.now() }));
  keys.forEach(k => store.saveKey(k));
  const model: Model = { audience: { type: 'selected', userIds: ['employee'] }, everPublished: true, id: 'glm-test', name: 'GLM Test', description: '测试模型', enabled: true, agents: ['claude-code', 'codex-cli', 'codex-desktop'], contextWindow: 128000, maxOutputTokens: 8192, routes: providers.map((p, index) => ({ providerId: p.id, upstreamModel: 'upstream-glm', weight: index === 0 ? 2 : 1, vision: false, contextWindow: 128000 })), createdAt: Date.now() };
  store.saveModel(model);
  return { store, box, admin, employee, providers, keys, model, apiKey: store.issue(employee.id, 'api', 'test-device').token, adminSession: store.issue(admin.id, 'session', 'test').token };
}
export const completion = (content = '完成', usage: unknown = { prompt_tokens: 10, completion_tokens: 5 }) => ({ id: id('chatcmpl'), object: 'chat.completion', model: 'upstream-glm', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage });
export function chatSSE(chunks: Record<string, any>[], done = true) {
  const text = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}
export const textChunks = () => [
  { choices: [{ index: 0, delta: { role: 'assistant', content: '你' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } },
];
