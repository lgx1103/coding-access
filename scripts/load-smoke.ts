import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fixture, completion } from '../tests/helpers.js';
import { createApp } from '../src/server/app.js';
import { digest } from '../src/server/security.js';

// Twenty independent employees, real sockets, twelve simulated independent Keys.
// This verifies scheduling behavior; it does not measure vendor capacity or quota.
const f = await fixture();
let active = 0; let peak = 0; const distribution = { zhipu: 0, volcano: 0 }; const firstRoutes: string[] = [];
const upstream = createServer(async (req, res) => {
  for await (const _ of req) { /* consume request */ }
  const provider = req.url?.startsWith('/zhipu/') ? 'zhipu' : 'volcano'; distribution[provider]++; if (firstRoutes.length < 16) firstRoutes.push(provider);
  active++; peak = Math.max(peak, active); await delay(50); active--;
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(completion('OK', { prompt_tokens: 100, completion_tokens: 60 })));
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
for (const p of f.providers) f.store.saveProvider({ ...p, endpoints: { chat: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/${p.id}` } });
f.store.db.exec('DELETE FROM keys');
for (const providerId of ['zhipu', 'volcano']) for (let i = 0; i < (providerId === 'zhipu' ? 8 : 4); i++) {
  const id = `${providerId}-${i}`; f.store.saveKey({ ...f.keys[0], id, providerId, name: id, secretHash: digest(id), encryptedSecret: f.box.seal(id) });
}
const employees = Array.from({ length: 20 }, (_, i) => {
  const user = { ...f.employee, id: `employee-${i}`, username: `employee-${i}` }; f.store.saveUser(user); return f.store.issue(user.id, 'api', 'load-test').token;
});
const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'http://127.0.0.1' }); await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
try {
  const started = Date.now();
  const statuses = await Promise.all(employees.flatMap(token => Array.from({ length: 10 }, async () => {
    const response = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'glm-test', input: 'Return OK.' }) }); await response.arrayBuffer(); return response.status;
  })));
  const requests = f.store.requests({ limit: 1000 }) as any[];
  const perEmployee = Object.fromEntries(employees.map((_, i) => [`employee-${i}`, requests.filter(r => r.user_id === `employee-${i}` && r.status === 'success').length]));
  const report = { createdAt: new Date().toISOString(), kind: 'local mock; real HTTP; no supplier calls', employees: 20, requests: 200, successful: statuses.filter(s => s === 200).length, elapsedMs: Date.now() - started, peakUpstreamConcurrency: peak, weights: { zhipu: 2, volcano: 1 }, distribution, firstRoutes, perEmployee, proactiveSharing: firstRoutes.includes('volcano') && firstRoutes.includes('zhipu') };
  mkdirSync('output/verification', { recursive: true }); writeFileSync('output/verification/load-smoke.json', JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.successful !== 200 || !report.proactiveSharing || peak > 16 || Object.values(perEmployee).some(n => n !== 10)) process.exitCode = 1;
} finally { app.server.closeAllConnections(); await app.close(); upstream.closeAllConnections(); upstream.close(); f.store.close(); }
