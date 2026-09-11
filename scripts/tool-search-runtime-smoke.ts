/** Validate the installed desktop app's bundled runtime against a local gateway.
 * Real runtime + real local MCP execution; upstream replies are deterministic.
 * No production service, supplier credential, desktop configuration or client build. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/server/app.js';
import { fixture, chatSSE, completion } from '../tests/helpers.js';
import type { Wire } from '../src/server/protocols.js';
const binary = process.argv[2];
if (!binary) throw new Error('Pass the desktop runtime binary path explicitly.');
const root = mkdtempSync(join(tmpdir(), 'aca-tool-search-'));
const reportDir = resolve('output/verification/server22'); mkdirSync(reportDir, { recursive: true });
const catalog = { models: [{ slug: 'glm-test', display_name: 'GLM protocol fixture', description: 'Local test', default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low', description: 'Low' }], shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 0, base_instructions: 'You are testing the local Coding Access protocol fixture.', supports_reasoning_summaries: false, support_verbosity: false, context_window: 128000, truncation_policy: { mode: 'tokens', limit: 10000 }, input_modalities: ['text'], supports_parallel_tool_calls: true, experimental_supported_tools: [], supports_search_tool: true }] };
writeFileSync(join(root, 'catalog.json'), JSON.stringify(catalog));
const f = await fixture();
let scenario = 'greeting'; let stage = 0;
const shapes: Wire[] = []; const upstream: Wire[] = [];
const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'http://127.0.0.1', gateway: { fetch: async (_, init) => {
  const body = JSON.parse(String(init!.body));
  upstream.push({ scenario, toolNames: body.tools.map((t: Wire) => t.function.name), messageRoles: body.messages.map((m: Wire) => m.role) });
  if (scenario === 'greeting') return chatSSE([{ choices: completion('你好，连接正常').choices.map(c => ({ ...c, delta: c.message })) }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }]);
  let name: string; let args: string;
  if (stage++ === 0) {
    assert(body.tools.some((t: Wire) => t.function.name === 'ca_client_tool_search'));
    name = 'ca_client_tool_search'; args = JSON.stringify({ query: '+aca_fixture read_fixture', limit: 1 });
  } else if (stage === 2) {
    const tool = body.tools.find((t: Wire) => t.function.name.endsWith('_read_fixture'));
    assert(tool, 'The runtime search result must become an upstream callable tool');
    name = tool.function.name; args = '{}';
  } else {
    assert(body.messages.some((m: Wire) => m.role === 'tool' && m.content.includes('ACA_TOOL_EXECUTED_42')), 'Actual MCP result must reach the upstream');
    return chatSSE([{ choices: completion('ACA_RUNTIME_ROUNDTRIP_OK').choices.map(c => ({ ...c, delta: c.message })) }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }]);
  }
  const split = Math.floor(args.length / 2);
  return chatSSE([
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `fixture_call_${stage}`, type: 'function', function: { name, arguments: args.slice(0, split) } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(split) } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ]);
} } });
app.addHook('preHandler', async req => {
  if (req.url !== '/v1/responses') return;
  const body = req.body as Wire;
  shapes.push({ scenario, keys: Object.keys(body), tools: body.tools, input: body.input.map((item: Wire) => ['tool_search_call', 'tool_search_output', 'function_call', 'function_call_output'].includes(item.type) ? item : { type: item.type, role: item.role }) });
});
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
const run = async (prompt: string) => {
  const args = ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only', '--disable', 'apps', '--disable', 'plugins', '--disable', 'shell_snapshot', '--disable', 'code_mode_host', '--json', '-C', root, '-m', 'glm-test', '-c', `model_catalog_json=${JSON.stringify(join(root, 'catalog.json'))}`, '-c', 'model_provider="aca_fixture"', '-c', `model_providers.aca_fixture={name="Fixture",base_url="${base}/v1",wire_api="responses",requires_openai_auth=false,env_key="ACA_FIXTURE_KEY"}`, '-c', 'web_search="disabled"', '-c', `mcp_servers.aca_fixture={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(resolve('scripts/fixtures/tool-search-mcp.mjs'))}],env={ACA_TEST_MCP_TRACE=${JSON.stringify(join(root, 'mcp.jsonl'))}}}`, prompt];
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(TOKEN|SECRET|API_KEY|PASSWORD|CODEX|ANTHROPIC|PROXY)/i.test(k)));
  // Explicit loopback proxy prevents the macOS system proxy intercepting the fixture.
  Object.assign(env, { ACA_FIXTURE_KEY: f.apiKey, HTTP_PROXY: base, HTTPS_PROXY: base, ALL_PROXY: base, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' });
  const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }); child.stdin.end();
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 45000);
  const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
  assert.equal(exit, 0, `Runtime failed: ${stdout}\n${stderr}`);
  assert(!stdout.includes('Reconnecting'), stdout);
  return stdout;
};
try {
  assert((await run('你好')).includes('你好，连接正常'));
  scenario = 'search-and-execute';
  assert((await run('Find the aca_fixture read_fixture tool and run it.')).includes('ACA_RUNTIME_ROUNDTRIP_OK'));
  const trace = readFileSync(join(root, 'mcp.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(trace.filter(t => t.method === 'tools/call').length, 1);
  assert.equal(shapes.length, 4); assert.equal(stage, 3);
  writeFileSync(join(reportDir, 'runtime-request-shapes.json'), JSON.stringify(shapes, null, 2));
  writeFileSync(join(reportDir, 'runtime-report.json'), JSON.stringify({ binary, status: 'passed', requests: shapes.length, actualMcpExecutions: 1, upstream: 'deterministic fixture, not live GLM', observations: upstream }, null, 2));
  console.log('PASS: bundled desktop runtime, greeting, search, actual MCP execution and streamed multi-request history');
} finally { await app.close(); f.store.close(); }
