// Local-only deterministic MCP fixture; it never reads user files or calls a network.
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const tools = [{ name: 'read_fixture', description: 'Read the synthetic Coding Access compatibility marker.', annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }];
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line); if (process.env.ACA_TEST_MCP_TRACE) appendFileSync(process.env.ACA_TEST_MCP_TRACE, JSON.stringify({ method: request.method, params: request.params }) + '\n'); if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'aca-fixture', version: '1.0.0' } };
  else if (request.method === 'tools/list') result = { tools };
  else if (request.method === 'tools/call' && request.params.name === 'read_fixture') result = { content: [{ type: 'text', text: 'ACA_TOOL_EXECUTED_42' }] };
  else result = {};
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}
