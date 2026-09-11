import { describe, expect, test } from 'vitest';
import { SecretBox } from '../src/server/security.js';
import { convertChatJSON, convertedChatStream, parseSSE, toChat } from '../src/server/protocols.js';
import { chatSSE } from './helpers.js';
const context = { box: new SecretBox(Buffer.alloc(32, 5).toString('base64')), owner: 'employee', modelId: 'glm-test' };
const tool = { type: 'function', name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const reply = { choices: [{ message: { role: 'assistant', reasoning_content: '需要读取文件', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/main.ts"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 30 } };
describe('agent tool protocol contracts', () => {
  test('Responses tool call, encrypted reasoning and result survive a full round trip', () => {
    const response = convertChatJSON(reply, 'responses', 'glm-test', { tools: [tool] }, context);
    const input = [{ role: 'user', content: '读取文件' }, ...response.output, { type: 'function_call_output', call_id: 'call_1', output: 'export const x=1' }];
    const converted = toChat({ model: 'glm-test', input, tools: [tool] }, 'responses', context);
    expect(converted.messages[1].reasoning_content).toBe('需要读取文件'); expect(converted.messages[1].tool_calls[0].id).toBe('call_1'); expect(JSON.parse(converted.messages[1].tool_calls[0].function.arguments).path).toBe('src/main.ts'); expect(converted.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'export const x=1' });
    expect(() => toChat({ input }, 'responses', { ...context, owner: 'other' })).toThrow('不匹配');
  });
  test('Codex custom tools wrap input strings and recover patch text without losing line breaks', () => {
    const tools = [{ type: 'custom', name: 'apply_patch', format: { type: 'grammar', definition: 'patch syntax' } }];
    const patch = '*** Begin Patch\n*** Add File: x\n+hi\n*** End Patch';
    const result = convertChatJSON({ choices: [{ message: { tool_calls: [{ id: 'patch-1', function: { name: 'apply_patch', arguments: JSON.stringify({ input: patch }) } }] }, finish_reason: 'tool_calls' }] }, 'responses', 'glm-test', { tools }, context);
    expect(result.output[0]).toMatchObject({ type: 'custom_tool_call', call_id: 'patch-1', input: patch });
    const converted = toChat({ tools, input: [...result.output, { type: 'custom_tool_call_output', call_id: 'patch-1', output: 'applied' }] }, 'responses', context);
    expect(JSON.parse(converted.messages[0].tool_calls[0].function.arguments).input).toBe(patch); expect(converted.tools[0].function.parameters.required).toEqual(['input']);
  });
  test('Responses namespaces distinguish same-named tools and restore namespace on replay', () => {
    const tools = ['files', 'remote'].map(name => ({ type: 'namespace', name, description: `${name} tools`, tools: [tool] }));
    const converted = toChat({ input: 'read', tools }, 'responses', context);
    const [local, remote] = converted.tools.map((t: any) => t.function.name);
    expect(local).not.toBe(remote); expect(local.length).toBeLessThanOrEqual(64);
    const response = convertChatJSON({ choices: [{ message: { tool_calls: [{ id: 'ns_call', function: { name: local, arguments: '{"path":"a"}' } }] }, finish_reason: 'tool_calls' }] }, 'responses', 'glm-test', { tools }, context);
    expect(response.output[0]).toMatchObject({ name: 'read_file', namespace: 'files', call_id: 'ns_call' });
    const replay = toChat({ input: [...response.output, { type: 'function_call_output', call_id: 'ns_call', output: 'contents' }], tools }, 'responses', context);
    expect(replay.messages[0].tool_calls[0].function.name).toBe(local); expect(replay.messages[1].tool_call_id).toBe('ns_call');
  });
  test('Messages thinking, tool_use and tool_result preserve call attribution', () => {
    const response = convertChatJSON(reply, 'messages', 'glm-test', {}, context);
    const converted = toChat({ messages: [{ role: 'assistant', content: response.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'contents' }] }] }] }, 'messages', context);
    expect(response.stop_reason).toBe('tool_use'); expect(converted.messages[0].reasoning_content).toBe('需要读取文件'); expect(converted.messages[1].tool_call_id).toBe('call_1');
  });
  test('fragmented function arguments retain stable item/call IDs through SSE events', async () => {
    const upstream = chatSSE([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x.ts"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }]);
    let text = ''; for await (const chunk of convertedChatStream(upstream.body!, 'responses', 'glm-test', { tools: [tool] }, context)) text += chunk.text;
    const events = text.split('\n').filter(x => x.startsWith('data: ')).map(x => JSON.parse(x.slice(6)));
    const added = events.find(e => e.type === 'response.output_item.added'); const done = events.find(e => e.type === 'response.output_item.done');
    expect(added.item.id).toBe(done.item.id); expect(done.item.call_id).toBe('call_1'); expect(done.item.arguments).toBe('{"path":"x.ts"}'); expect(events.at(-1).type).toBe('response.completed'); expect(events.map(e => e.sequence_number)).toEqual(events.map((_, i) => i));
  });
  test('SSE parser joins fragmented UTF-8 and handles CRLF', async () => {
    const bytes = new TextEncoder().encode('event: message\r\ndata: {"text":"你好"}\r\n\r\n'); let index = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (index >= bytes.length) c.close(); else c.enqueue(bytes.slice(index, ++index)); } });
    const frames = []; for await (const frame of parseSSE(stream)) frames.push(frame); expect(frames[0].data).toBe('{"text":"你好"}');
  });
  test('Messages streams close thinking and text before sequential parallel tool blocks', async () => {
    const upstream = chatSSE([
      { choices: [{ delta: { reasoning_content: '先检查两个文件' } }] },
      { choices: [{ delta: { content: '正在读取。' } }] },
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{"path":' } },
        { index: 1, id: 'call_b', function: { name: 'read_file', arguments: '{"path":"b"}' } },
      ] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, finish_reason: 'tool_calls' }] },
    ]);
    let text = ''; for await (const chunk of convertedChatStream(upstream.body!, 'messages', 'glm-test', {}, context)) text += chunk.text;
    const events = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    let active: number | undefined; const types: string[] = []; const argumentsByBlock = new Map<number, string>();
    for (const event of events) {
      if (event.type === 'content_block_start') { expect(active).toBeUndefined(); active = event.index; types.push(event.content_block.type); }
      if (event.type === 'content_block_delta') { expect(active).toBe(event.index); if (event.delta.partial_json) argumentsByBlock.set(event.index, (argumentsByBlock.get(event.index) ?? '') + event.delta.partial_json); }
      if (event.type === 'content_block_stop') { expect(active).toBe(event.index); active = undefined; }
    }
    expect(active).toBeUndefined(); expect(types).toEqual(['thinking', 'text', 'tool_use', 'tool_use']);
    expect([...argumentsByBlock.values()].map(value => JSON.parse(value))).toEqual([{ path: 'a' }, { path: 'b' }]); expect(events.at(-1).type).toBe('message_stop');
  });
  test('unsupported hosted tools and opaque cross-provider conversation IDs fail explicitly', () => {
    expect(() => toChat({ input: 'hi', tools: [{ type: 'web_search' }] }, 'responses', context)).toThrow('托管工具');
    expect(() => toChat({ input: 'hi', previous_response_id: 'opaque' }, 'responses', context)).toThrow('完整历史');
  });
});
