import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fixture } from '../tests/helpers.js';
import { createApp } from '../src/server/app.js';
import { ConfigManager } from '../src/desktop/config.js';
import { findTool } from '../src/desktop/launch.js';
import { homedir } from 'node:os';

// Integration fixture: real installed CLIs talk only to a local deterministic mock.
const directory = resolve('.local/agent-smoke', String(Date.now()));
const project = join(directory, 'project'); mkdirSync(project, { recursive: true }); writeFileSync(join(project, 'hello.txt'), 'CODING_ACCESS_TOOL_OK\n');
const observations: { protocol: string; toolNames: string[]; toolResult: boolean; chosenTool?: string }[] = [];
const upstream = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks).toString());
  const native = req.url?.endsWith('/v1/messages');
  const names = (body.tools ?? []).map((t: any) => t.function?.name ?? t.name ?? t.type);
  const result = (body.messages ?? []).some((m: any) => m.role === 'tool' || Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result'));
  const chosen = names.find((n: string) => /^(Read|read_file|exec_command|shell_command|shell)$/.test(n));
  observations.push({ protocol: native ? 'messages' : 'chat', toolNames: names, toolResult: result, chosenTool: chosen });
  if (native) {
    const block = result ? { type: 'text', text: 'CODING_ACCESS_TOOL_OK' } : { type: 'tool_use', id: 'call_native', name: 'Read', input: { file_path: join(project, 'hello.txt') } };
    const message = { id: 'msg_native', type: 'message', role: 'assistant', model: body.model, content: [block], stop_reason: result ? 'end_turn' : 'tool_use', stop_sequence: null, usage: { input_tokens: 35, output_tokens: 18 } };
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type: string, fields: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    event('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 35, output_tokens: 0 } } });
    event('content_block_start', { index: 0, content_block: result ? { type: 'text', text: '' } : { ...block, input: {} } });
    event('content_block_delta', { index: 0, delta: result ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    event('content_block_stop', { index: 0 }); event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 18 } }); event('message_stop', {}); res.end(); return;
  }
  let delta: any = { content: result ? 'CODING_ACCESS_TOOL_OK' : 'CODING_ACCESS_CONNECTED' }; let finish = 'stop';
  if (chosen && !result) {
    const props = body.tools.find((t: any) => t.function?.name === chosen)?.function.parameters?.properties ?? {};
    const args = chosen === 'Read' ? { file_path: join(project, 'hello.txt') } : chosen === 'read_file' ? { path: 'hello.txt' } : chosen === 'exec_command' ? { cmd: 'cat hello.txt', workdir: project, max_output_tokens: 1000 } : { command: props.command?.type === 'array' ? ['/bin/sh', '-lc', 'cat hello.txt'] : 'cat hello.txt', workdir: project };
    delta = { tool_calls: [{ index: 0, id: 'call_smoke_1', type: 'function', function: { name: chosen, arguments: JSON.stringify(args) } }] }; finish = 'tool_calls';
  }
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'chat-smoke', choices: [{ message: { role: 'assistant', ...delta }, finish_reason: finish }], usage: { prompt_tokens: 35, completion_tokens: 18 } })); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 35, completion_tokens: 18 } })}\n\ndata: [DONE]\n\n`);
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const f = await fixture(); for (const p of f.providers) f.store.saveProvider({ ...p, endpoints: { chat: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` } });
const { app, gateway } = await createApp({ store: f.store, box: f.box, publicUrl: 'http://127.0.0.1' });
const http: any[] = []; app.addHook('onResponse', async (request, reply) => { http.push({ url: request.url, status: reply.statusCode, encoding: request.headers['content-encoding'], authorizationPresent: Boolean(request.headers.authorization), type: request.headers['content-type'] }); });
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
const config = new ConfigManager(join(directory, 'home'), join(directory, 'state'), {});
const model = gateway.catalog(f.employee)[0];
const report: any[] = [];
try {
  for (const [agent, native] of [['claude-code', true], ['claude-code', false], ['codex-cli', false]] as const) {
    for (const p of f.providers) f.store.saveProvider({ ...p, endpoints: { chat: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, ...(native ? { messages: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` } : {}) } });
    const path = agent === 'codex-cli' ? process.env.ACA_TEST_CODEX_BIN ?? findTool(agent, homedir()) : findTool(agent, homedir()); if (!path) { report.push({ agent, skipped: 'not installed' }); continue; }
    config.apply(agent, model, base, f.apiKey, 'smoke-credential');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/ANTHROPIC|OPENAI|CLAUDE|CODEX|API_KEY|PROXY|RUST_LOG/i.test(key))) as NodeJS.ProcessEnv;
    Object.assign(env, { CODEX_HOME: join(directory, 'home/.codex'), CLAUDE_CONFIG_DIR: join(directory, 'home/.claude'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: f.apiKey, ANTHROPIC_API_KEY: f.apiKey, CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192' });
    env.NO_PROXY = '*'; env.no_proxy = '*';
    const args = agent === 'codex-cli' ? ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '-C', project, 'Read hello.txt using a local tool and report its contents.'] : ['--safe-mode', '--setting-sources', 'user', '--strict-mcp-config', '--no-session-persistence', '--tools', 'Read', '--allowedTools', 'Read', '-p', '--output-format', 'json', 'Read hello.txt using the Read tool and report its contents.'];
    const before = observations.length; const child = spawn(path, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
    const [exit] = await once(child, 'exit'); clearTimeout(timer);
    const result = { agent, upstreamProtocol: native ? 'messages' : 'chat', exit, success: exit === 0 && stdout.includes('CODING_ACCESS_TOOL_OK') && observations.slice(before).some(o => o.toolResult), observations: observations.slice(before), stdout, stderr };
    report.push(result); process.stdout.write(JSON.stringify({ agent, exit, success: result.success, upstreamProtocol: result.upstreamProtocol, requests: result.observations.length, tool: result.observations[0]?.chosenTool, ...(!result.success ? { stderr: stderr.slice(-1800), stdout: stdout.slice(-3000) } : {}) }, null, 2) + '\n');
  }
} finally {
  mkdirSync('output/verification', { recursive: true }); writeFileSync('output/verification/agent-smoke.json', JSON.stringify({ createdAt: new Date().toISOString(), fixtureDirectory: directory, report, http, requests: f.store.requests() }, null, 2));
  app.server.closeAllConnections(); await app.close(); f.store.close(); upstream.closeAllConnections(); upstream.close();
}
if (report.some(r => !r.skipped && !r.success)) process.exitCode = 1;
