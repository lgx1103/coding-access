import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Gateway } from '../src/server/gateway.js';
import { completion, fixture } from './helpers.js';
import { parseSSE } from '../src/server/protocols.js';
import { setTimeout as delay } from 'node:timers/promises';
const close: (() => Promise<void> | void)[] = []; afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); });
async function upstream(handler: RequestListener) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  close.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
describe('real local HTTP transport', () => {
  test('a Responses tool call is converted, streamed and replayed with its result over sockets', async () => {
    const bodies: any[] = [];
    const base = await upstream(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const toolResult = body.messages.some((m: any) => m.role === 'tool');
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: toolResult ? { content: '文件共有 3 行。' } : { tool_calls: [{ index: 0, id: 'call-local', function: { name: 'read_file', arguments: '{"path":"x.ts"}' } }] }, finish_reason: null }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: toolResult ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 31, completion_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
    });
    const f = await fixture(); close.push(() => f.store.close()); for (const p of f.providers) f.store.saveProvider({ ...p, endpoints: { chat: base } });
    const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'http://127.0.0.1' }); await app.listen({ host: '127.0.0.1', port: 0 }); close.push(async () => { app.server.closeAllConnections(); await app.close(); }); const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const tools = [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
    async function send(input: any) { const response = await fetch(`${url}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${f.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'glm-test', input, tools, stream: true }) }); expect(response.status).toBe(200); const events = []; for await (const frame of parseSSE(response.body!)) if (frame.data) events.push(JSON.parse(frame.data)); return events.find(e => e.type === 'response.completed').response; }
    const first = await send('读取 x.ts'); expect(first.output[0].call_id).toBe('call-local');
    const second = await send([{ role: 'user', content: '读取 x.ts' }, ...first.output, { type: 'function_call_output', call_id: 'call-local', output: 'a\nb\nc' }]);
    expect(second.output[0].content[0].text).toBe('文件共有 3 行。'); expect(bodies[1].messages.at(-1).tool_call_id).toBe('call-local'); expect(f.store.stats().requests).toBe(2);
  });
  test('aborting an HTTP client closes its upstream stream and releases pool capacity', async () => {
    let upstreamClosed = false;
    const base = await upstream(async (req, res) => {
      for await (const _ of req) { /* Consume request before starting streaming. */ }
      res.on('close', () => { upstreamClosed = true; }); res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '开始' } }] })}\n\n`);
    });
    const f = await fixture(); close.push(() => f.store.close()); for (const p of f.providers) f.store.saveProvider({ ...p, endpoints: { chat: base } });
    const { app, gateway } = await createApp({ store: f.store, box: f.box, publicUrl: 'http://127.0.0.1' }); await app.listen({ host: '127.0.0.1', port: 0 }); close.push(async () => { app.server.closeAllConnections(); await app.close(); });
    const controller = new AbortController(); const response = await fetch(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${f.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'glm-test', input: 'hi', stream: true }), signal: controller.signal });
    const reader = response.body!.getReader(); await reader.read(); controller.abort(); await reader.cancel().catch(() => {});
    for (let i = 0; i < 50 && (!upstreamClosed || gateway.pool.active('z1')); i++) await delay(10);
    expect(upstreamClosed).toBe(true); expect(gateway.pool.active('z1')).toBe(0); expect(f.store.requests()[0].status).toBe('cancelled');
  });
  test('an expired provider cooldown allows one recovery probe, and idle alternative serves concurrent work', async () => {
    const f = await fixture(); close.push(() => f.store.close()); f.store.block('provider-model:zhipu:glm-test', Date.now() - 1, 'overloaded');
    let complete!: () => void; const wait = new Promise<void>(resolve => { complete = resolve; }); const seen: string[] = [];
    const gateway = new Gateway(f.store, f.box, { fetch: async (url) => { const u = String(url); seen.push(u); if (u.includes('zhipu')) await wait; return Response.json(completion()); } });
    const first = gateway.execute(f.apiKey, { model: 'glm-test', input: 'hi' }, 'responses', 'codex-cli');
    while (!seen.length) await delay(1);
    const second = await gateway.execute(f.apiKey, { model: 'glm-test', input: 'hi' }, 'responses', 'codex-cli');
    expect(seen[1]).toContain('volcano'); complete(); await first; expect(second.json).toBeTruthy(); expect(f.store.recoveryScopes(f.keys[0], 'glm-test')).toHaveLength(0);
  });
  test('rejecting oversized stream prelude closes the upstream even before output starts', async () => {
    let disconnected = false;
    const base = await upstream(async (req, res) => {
      for await (const _ of req) { /* consume request */ }
      res.on('close', () => { disconnected = true; }); res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'message_start', message: { id: 'm', model: 'upstream', metadata: 'x'.repeat(270000) } })}\n\n`);
    });
    const f = await fixture(); close.push(() => f.store.close()); for (const p of f.providers) f.store.saveProvider({ ...p, endpoints: { messages: base } });
    const gateway = new Gateway(f.store, f.box);
    await expect(gateway.execute(f.apiKey, { model: 'glm-test', messages: [{ role: 'user', content: 'hi' }], stream: true }, 'messages', 'claude-code')).rejects.toMatchObject({ code: 'stream_prelude_limit' });
    for (let i = 0; i < 50 && !disconnected; i++) await delay(10);
    expect(disconnected).toBe(true); expect(gateway.pool.active('z1')).toBe(0);
  });
});
