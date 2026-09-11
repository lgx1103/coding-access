import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { Store } from '../src/server/db.js';
import { createApp } from '../src/server/app.js';
import { SecretBox, digest, hashPassword } from '../src/server/security.js';

const demoPassword = 'DemoAccess2026!';
const upstreamPort = Number(process.env.ACA_DEMO_UPSTREAM_PORT ?? 4318);
const port = Number(process.env.ACA_PORT ?? 4317);
const upstream = createServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  let body: Record<string, any>;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { response.writeHead(400).end(); return; }
  const authorization = request.headers.authorization ?? '';
  if (authorization.includes('expired')) { response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'invalid_api_key', message: '演示：此 Key 已失效' } })); return; }
  const text = '连接已通过。这是本地演示响应，未调用真实模型。';
  if (!body.stream) { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'chatcmpl-demo', model: body.model, choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 24, completion_tokens: 16 } })); return; }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const part of ['连接已通过。', '这是本地演示响应，', '未调用真实模型。']) response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  response.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 24, completion_tokens: 16 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
mkdirSync('.local/demo', { recursive: true, mode: 0o700 });
const store = new Store('.local/demo/access.sqlite');
const box = new SecretBox(Buffer.alloc(32, 42).toString('base64'));
if (store.users().length === 0) {
  const passwordHash = await hashPassword(demoPassword);
  const names = ['管理员', '陈嘉', '林远', '许知行', '周予安', '吴彤'];
  names.forEach((name, i) => store.saveUser({ id: `demo-user-${i}`, username: i ? `dev${i}` : 'admin', name, role: i ? 'employee' : 'admin', enabled: true, mustChangePassword: false, passwordHash, models: ['glm-5.3', 'glm-5.3-flash', 'deepseek-chat'], createdAt: Date.now() - (8 + i) * 86400_000 }));
  for (const [providerId, name, product] of [['demo-zhipu', '智谱', 'Coding Plan · 6 团队标准 + 2 个人 Pro'], ['demo-volcano', '火山方舟', 'Coding Plan · 3 Pro + 1 Lite'], ['demo-deepseek', 'DeepSeek', '按量 API']]) {
    store.saveProvider({ id: providerId, name, product, enabled: true, endpoints: { chat: `http://127.0.0.1:${upstreamPort}/v1` }, auth: 'bearer', headers: {}, defaults: {}, createdAt: Date.now() });
    const count = providerId === 'demo-zhipu' ? 8 : providerId === 'demo-volcano' ? 4 : 1;
    for (let i = 0; i < count; i++) {
      const secret = `demo-${providerId}-${i === 7 ? 'expired' : i}`;
      const key = { id: `${providerId}-key-${i}`, providerId, name: `${name}-${String(i + 1).padStart(2, '0')}`, enabled: true, secretHash: digest(secret), encryptedSecret: box.seal(secret), hint: `••••${String(i + 1).padStart(4, '0')}`, models: [], maxConcurrent: 2, weight: 1, rateScope: 'key' as const, group: '', createdAt: Date.now() };
      store.saveKey(key); if (i !== 7) store.success(key);
      else { store.block(`invalid:${key.id}`, Date.now() + 365 * 86400_000, 'invalid_api_key'); store.event(key.id, 'invalid_api_key', '智谱-08 的访问凭证已失效，需要更新 Key'); }
    }
  }
  for (const [modelId, name, description] of [['glm-5.3', 'GLM-5.3', '复杂任务与深度编码'], ['glm-5.3-flash', 'GLM-5.3-Flash', '快速响应，轻快完成日常开发'], ['deepseek-chat', 'DeepSeek Chat', '按需选择的独立模型']]) {
    store.saveModel({ id: modelId, name, description, enabled: true, agents: ['claude-code', 'codex-cli', 'codex-desktop', 'zcode'], contextWindow: 128000, maxOutputTokens: 8192, routes: (modelId.startsWith('glm') ? ['demo-zhipu', 'demo-volcano'] : ['demo-deepseek']).map((providerId, i) => ({ providerId, upstreamModel: modelId, weight: i ? 1 : 2, vision: modelId.includes('flash'), contextWindow: 128000 })), createdAt: Date.now() });
  }
  for (let day = 6; day >= 0; day--) for (let i = 0; i < 14 + (6 - day) * 7; i++) {
    const userId = `demo-user-${i % 6}`;
    const modelId = i % 4 ? 'glm-5.3' : 'glm-5.3-flash';
    const keyId = i % 3 ? `demo-zhipu-key-${i % 7}` : `demo-volcano-key-${i % 4}`;
    const requestId = store.beginRequest(userId, modelId, i % 2 ? 'claude-code' : 'codex-cli');
    const time = Date.now() - day * 86400_000 - i * 35_000;
    const retry = i % 13 === 0; const failed = i % 31 === 0;
    if (retry) store.attempt({ id: `${requestId}-retry`, requestId, providerId: 'demo-zhipu', keyId: 'demo-zhipu-key-0', startedAt: time, finishedAt: time + 90, status: 'error', httpStatus: 429, code: 'rate_limit', message: '演示：短暂限流后自动切换', input: null, output: null, cached: null });
    store.attempt({ id: `${requestId}-final`, requestId, providerId: keyId.includes('volcano') ? 'demo-volcano' : 'demo-zhipu', keyId, startedAt: time + 100, finishedAt: time + 2400, status: failed ? 'error' : 'success', httpStatus: failed ? 503 : 200, input: failed ? null : 1200 + i * 151, output: failed ? null : 380 + i * 21, cached: failed ? null : 160 });
    store.finishRequest(requestId, failed ? 'error' : 'success', failed ? 'no_available_channel' : undefined, failed ? '演示：模型暂不可用' : undefined, 430 + i * 8);
    store.db.prepare('UPDATE requests SET started_at=?,finished_at=? WHERE id=?').run(time, time + 2400, requestId);
  }
  store.saveVersion('demo-user-0', '演示初始配置');
}
const { app } = await createApp({ store, box, publicUrl: `http://127.0.0.1:${port}`, companyName: 'Coding Access', demo: true, development: true });
await app.listen({ port, host: '127.0.0.1' });
process.stdout.write(`本地演示已启动：http://127.0.0.1:${port}\n管理员：admin / ${demoPassword}\n员工：dev1 / ${demoPassword}\n演示不会调用真实供应商。\n`);
const stop = async () => { await app.close(); store.close(); upstream.close(() => process.exit(0)); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
