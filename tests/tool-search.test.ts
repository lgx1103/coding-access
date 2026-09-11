import { describe, expect, test } from 'vitest';
import desktopRequest from './fixtures/desktop-tool-search.json';
import { convertChatJSON, convertedChatStream, nativeStream, toChat, type Wire } from '../src/server/protocols.js';
import { Gateway } from '../src/server/gateway.js';
import { SecretBox } from '../src/server/security.js';
import { chatSSE, completion, fixture } from './helpers.js';
const context = { box: new SecretBox(Buffer.alloc(32, 5).toString('base64')), owner: 'employee', modelId: 'glm-test' };
const search = { type: 'tool_search', execution: 'client', description: 'Find relevant tools', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } };
const ns = (name: string) => ({ type: 'namespace', name, description: name, tools: [{ type: 'function', name: 'read_fixture', defer_loading: true, parameters: { type: 'object', properties: {}, additionalProperties: false } }, { type: 'custom', name: 'patch', format: { type: 'text' } }] });
const request: Wire = { model: 'glm-test', input: [{ role: 'user', content: '你好' }], tools: [search], parallel_tool_calls: false };
const callReply = (name: string, args = '{"query":"fixture"}', callId = 'search_1') => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name, arguments: args } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const searchName = toChat(request, 'responses', context).tools[0].function.name;
const searchCall = convertChatJSON(callReply(searchName), 'responses', 'glm-test', request, context).output[0];
const searchOutput = { type: 'tool_search_output', execution: 'client', call_id: 'search_1', status: 'completed', tools: [ns('files'), ns('other')] };
const followup: Wire = { ...request, input: [...request.input, searchCall, searchOutput] };

describe('client-executed Responses tool search', () => {
  test('replays the actual desktop runtime request with deferred namespaced results', () => {
    const chat = toChat(desktopRequest, 'responses', context);
    expect(chat.tools.some((t: Wire) => t.function.name.endsWith('_read_fixture'))).toBe(true);
    expect(chat.messages.at(-1).content).toContain('ACA_TOOL_EXECUTED_42');
    expect(chat.messages.at(-1).tool_call_id).toBe('fixture_call_2');
  });
  test('ordinary chat retains the search schema without forcing discovery', () => {
    const chat = toChat(request, 'responses', context);
    expect(chat.tools[0].function).toEqual({ name: searchName, description: search.description, parameters: search.parameters });
    expect(chat).not.toHaveProperty('tool_choice'); expect(chat.parallel_tool_calls).toBe(false);
    expect(convertChatJSON(completion('你好'), 'responses', 'glm-test', request, context).output[0].content[0].text).toBe('你好');
    expect(toChat({ ...request, tool_choice: { type: 'tool_search' } }, 'responses', context).tool_choice.function.name).toBe(searchName);
  });
  test('search calls carry object arguments, execution and original call ID', () => {
    expect(searchCall).toMatchObject({ type: 'tool_search_call', execution: 'client', status: 'completed', call_id: 'search_1', arguments: { query: 'fixture' } });
    expect(searchCall).not.toHaveProperty('name');
    const chat = toChat(followup, 'responses', context);
    expect(chat.messages[1].tool_calls[0]).toMatchObject({ id: 'search_1', function: { name: searchName, arguments: '{"query":"fixture"}' } });
    expect(chat.messages[2].tool_call_id).toBe('search_1'); expect(JSON.parse(chat.messages[2].content).tools).toHaveLength(4);
    expect(chat.tools).toHaveLength(5);
  });
  test('discovered function and custom tool namespaces survive calls and full history', () => {
    const chat = toChat(followup, 'responses', context);
    expect(chat.tools[1].function.name).not.toBe(chat.tools[3].function.name);
    const run = convertChatJSON(callReply(chat.tools[1].function.name, '{}', 'run_1'), 'responses', 'glm-test', followup, context).output[0];
    expect(run).toMatchObject({ type: 'function_call', name: 'read_fixture', namespace: 'files', call_id: 'run_1' });
    const patch = convertChatJSON(callReply(chat.tools[2].function.name, '{"input":"patch text"}', 'patch_1'), 'responses', 'glm-test', followup, context).output[0];
    expect(patch).toMatchObject({ type: 'custom_tool_call', name: 'patch', namespace: 'files', input: 'patch text' });
    const third = toChat({ ...followup, input: [...followup.input, run, { type: 'function_call_output', call_id: run.call_id, output: 'fixture value' }, patch, { type: 'custom_tool_call_output', call_id: patch.call_id, output: 'applied' }, { role: 'user', content: '继续' }] }, 'responses', context);
    expect(third.messages.at(-2)).toEqual({ role: 'tool', tool_call_id: 'patch_1', content: 'applied' });
    expect(third.tools).toHaveLength(5);
  });
  test('empty results, repeated results, additional_tools and no cross-request leakage', () => {
    const empty = toChat({ ...followup, input: [...request.input, searchCall, { ...searchOutput, tools: [] }] }, 'responses', context);
    expect(empty.tools).toHaveLength(1); expect(empty.messages.at(-1).content).toBe('{"tools":[]}');
    const additional = { type: 'additional_tools', role: 'developer', tools: [ns('files')] };
    const combined = toChat({ ...followup, input: [...followup.input, additional, additional] }, 'responses', context);
    expect(combined.tools).toHaveLength(5); expect(combined.messages.at(-1).role).toBe('system');
    expect(toChat(request, 'responses', context).tools).toHaveLength(1);
    expect(toChat({ ...request, tools: [search, ns('deferred')] }, 'responses', context).tools.map((t: Wire) => t.function.name)).not.toContain('read_fixture');
    // History alone supplies definitions even if top-level tools are omitted.
    expect(toChat({ input: followup.input }, 'responses', context).tools).toHaveLength(4);
  });
  test('malformed client search and unsupported hosted search fail explicitly', () => {
    for (const tools of [[{ type: 'tool_search' }], [{ ...search, execution: 'server' }], [{ ...search, parameters: null }], [search, { type: 'function', name: searchName }]]) expect(() => toChat({ ...request, tools }, 'responses', context)).toThrow();
    for (const output of [{ ...searchOutput, call_id: null }, { ...searchOutput, tools: null }, { ...searchOutput, execution: 'server' }]) expect(() => toChat({ ...request, input: [searchCall, output] }, 'responses', context)).toThrow();
    expect(() => convertChatJSON(callReply(searchName, '[]'), 'responses', 'glm-test', request, context)).toThrow();
    expect(() => convertChatJSON(callReply(searchName, '{'), 'responses', 'glm-test', request, context)).toThrow();
  });
  test('fragmented streamed arguments become a completed search item, not a function call', async () => {
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 's', function: { name: searchName, arguments: '{"que' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"fixture"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
    ];
    const events = [];
    for await (const c of convertedChatStream(chatSSE(chunks).body!, 'responses', 'glm-test', request, context)) events.push({ ...c, data: JSON.parse(c.text.split('data: ')[1]) });
    expect(events.filter(e => e.meaningful)).not.toHaveLength(0);
    expect(events.map(e => e.data.type)).not.toContain('response.function_call_arguments.delta');
    const done = events.find(e => e.data.type === 'response.output_item.done')!.data.item;
    expect(done).toMatchObject({ type: 'tool_search_call', call_id: 's', arguments: { query: 'fixture' }, status: 'completed' });
    expect(events.at(-1)!.data.response.output).toEqual([done]);
    expect(events.at(-1)!.data.response.usage.total_tokens).toBe(15);
    expect(events.map(e => e.data.sequence_number)).toEqual(events.map((_, i) => i));
  });
  test('parallel search and regular calls keep separate IDs and argument buffers', async () => {
    const mixed = { ...request, tools: [search, { type: 'function', name: 'direct', parameters: { type: 'object' } }] };
    const body = callReply(searchName);
    body.choices[0].message.tool_calls.push({ id: 'direct_2', type: 'function', function: { name: 'direct', arguments: '{}' } });
    const output = convertChatJSON(body, 'responses', 'glm-test', mixed, context).output;
    expect(output.map((item: Wire) => [item.type, item.call_id])).toEqual([['tool_search_call', 'search_1'], ['function_call', 'direct_2']]);
    const replay = toChat({ ...mixed, input: [...request.input, ...output, { ...searchOutput, tools: [] }, { type: 'function_call_output', call_id: 'direct_2', output: 'ok' }] }, 'responses', context);
    expect(replay.messages[1].tool_calls).toHaveLength(2);
    expect(replay.messages.slice(2).map((m: Wire) => m.tool_call_id)).toEqual(['search_1', 'direct_2']);
  });
  test('native search starts count as meaningful before a broken stream', async () => {
    const text = `data: ${JSON.stringify({ type: 'response.output_item.added', item: searchCall })}\n\n`;
    const iterator = nativeStream(new Response(text).body!, 'responses', 'glm-test');
    expect((await iterator.next()).value?.meaningful).toBe(true);
    await expect(iterator.next()).rejects.toThrow();
  });
});

describe('gateway search / execute / follow-up round trip', () => {
  test('a broken search stream does not retry after exposing a call', async () => {
    const f = await fixture(); let requests = 0;
    const gateway = new Gateway(f.store, f.box, { fetch: async () => {
      requests++;
      return chatSSE([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'search_broken', function: { name: searchName, arguments: '{' } }] } }] }], false);
    } });
    try {
      const result = await gateway.execute(f.apiKey, { ...request, stream: true }, 'responses', 'codex-desktop');
      let text = ''; for await (const chunk of result.stream!) text += chunk;
      expect(text).toContain('tool_search_call'); expect(text).toContain('incomplete_stream');
      expect(text).not.toContain('response.completed'); expect(requests).toBe(1);
      expect(gateway.pool.live().active).toBe(0);
    } finally { f.store.close(); }
  });
  test.each([false, true])('real local tool execution with stream=%s', async stream => {
    const f = await fixture(); let step = 0; let executions = 0;
    const gateway = new Gateway(f.store, f.box, { fetch: async (_, init) => {
      const body = JSON.parse(String(init!.body));
      let reply;
      if (step++ === 0) reply = callReply(body.tools[0].function.name);
      else if (step === 2) {
        expect(body.messages.at(-1).tool_call_id).toBe('search_1');
        reply = callReply(body.tools.find((t: Wire) => t.function.name !== searchName).function.name, '{}', 'run_1');
      } else {
        expect(body.messages.some((m: Wire) => m.role === 'tool' && m.content === 'ACA_TOOL_EXECUTED_42')).toBe(true);
        reply = completion(step === 3 ? '已读取 42' : '再次确认 42');
      }
      return stream ? chatSSE([{ choices: reply.choices.map(c => ({ ...c, delta: c.message })) }, { choices: [], usage: reply.usage }]) : Response.json(reply);
    } });
    const input: Wire[] = [...request.input];
    const send = async () => {
      const result = await gateway.execute(f.apiKey, { ...request, input, stream }, 'responses', 'codex-desktop');
      if (!stream) return result.json!;
      let text = ''; for await (const chunk of result.stream!) text += chunk;
      expect(text).not.toContain('response.failed');
      return text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))).find(e => e.type === 'response.completed').response;
    };
    try {
      const one = await send(); input.push(...one.output, { ...searchOutput, tools: [ns('files')] });
      const two = await send(); const call = two.output[0]; expect(call.namespace).toBe('files');
      // The client, not the gateway, dispatches the discovered executable function.
      const tools: Record<string, () => string> = { read_fixture: () => { executions++; return 'ACA_TOOL_EXECUTED_42'; } };
      const output = tools[call.name](); input.push(...two.output, { type: 'function_call_output', call_id: call.call_id, output });
      const three = await send(); expect(three.output[0].content[0].text).toBe('已读取 42');
      input.push(...three.output, { role: 'user', content: '再确认一次' });
      expect((await send()).output[0].content[0].text).toBe('再次确认 42');
      expect(executions).toBe(1); expect(step).toBe(4); expect(f.store.stats().requests).toBe(4);
    } finally { f.store.close(); }
  });
});
