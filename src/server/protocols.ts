import type { Protocol, Usage } from '../shared/types.js';
import { ApiError } from './errors.js';
import { digest, id, type SecretBox } from './security.js';

/** Wire objects are open records because provider extensions are forwarded intact
 * on native paths. Converting paths explicitly inspect the supported structures. */
export type Wire = Record<string, any>;
export const unknownUsage = (): Usage => ({ input: null, output: null, cached: null });
export function readUsage(body: Wire, previous = unknownUsage(), protocol?: Protocol): Usage {
  const u = body.usage ?? body.message?.usage ?? body.response?.usage;
  if (!u) return previous;
  const n = (v: unknown, fallback: number | null) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
  return {
    input: protocol === 'messages' && n(u.input_tokens, null) !== null
      ? u.input_tokens + (n(u.cache_read_input_tokens, 0) ?? 0) + (n(u.cache_creation_input_tokens, 0) ?? 0)
      : n(u.input_tokens ?? u.prompt_tokens, previous.input),
    output: n(u.output_tokens ?? u.completion_tokens, previous.output),
    cached: n(u.cache_read_input_tokens ?? u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens, previous.cached),
  };
}
export function hasImage(body: Wire): boolean {
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(visit);
    const item = value as Wire;
    if (['image', 'input_image', 'image_url'].includes(item.type)) return true;
    return Object.values(item).some(visit);
  };
  return visit(body.messages ?? body.input);
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => typeof c === 'string' ? c : c?.text ?? JSON.stringify(c)).join('\n');
  return content == null ? '' : JSON.stringify(content);
}
function chatContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new ApiError(400, 'unsupported_content', '消息内容需要是文本或内容块列表');
  return content.map((c: Wire) => {
    if (['text', 'input_text', 'output_text'].includes(c.type)) return { type: 'text', text: c.text ?? '' };
    if (c.type === 'image_url') return c;
    if (c.type === 'input_image') return { type: 'image_url', image_url: { url: c.image_url, ...(c.detail ? { detail: c.detail } : {}) } };
    if (c.type === 'image' && c.source?.type === 'base64') return { type: 'image_url', image_url: { url: `data:${c.source.media_type};base64,${c.source.data}` } };
    if (c.type === 'image' && c.source?.type === 'url') return { type: 'image_url', image_url: { url: c.source.url } };
    throw new ApiError(400, 'unsupported_content', `当前协议转换尚不支持内容类型：${c.type}`);
  });
}

export interface ConversionContext { box: SecretBox; owner: string; modelId: string }
// Chat Completions has no namespace field. Stable, bounded aliases preserve
// disambiguation across namespaces and replay; Responses receives original names.
function toolAlias(name: string, namespace?: string): string {
  return namespace ? `ca_${digest(`${namespace}\0${name}`).slice(0, 12)}_${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)}` : name;
}
function responseTools(tools: Wire[] = []): Wire[] {
  return tools.flatMap(tool => {
    if (tool.type !== 'namespace') return [tool];
    if (typeof tool.name !== 'string' || !Array.isArray(tool.tools)) throw new ApiError(400, 'invalid_tool_namespace', '工具命名空间缺少名称或工具列表');
    return tool.tools.map((child: Wire) => {
      if (!['function', 'custom'].includes(child.type)) throw new ApiError(400, 'unsupported_tool', `命名空间中不支持此工具类型：${child.type}`);
      return { ...child, namespace: tool.name, description: [tool.description, child.description].filter(Boolean).join('\n') };
    });
  });
}
// A private Chat function represents the client-executed Responses search tool.
// Never expose this alias back to the client or execute discovery in the gateway.
const SEARCH_ALIAS = 'ca_client_tool_search';
function searchExecution(item: Wire) {
  if (item.execution !== 'client') throw new ApiError(400, 'unsupported_tool_search_execution', '此转换通道支持客户端工具搜索；托管工具搜索需要原生 Responses 接入');
}
function searchCallId(item: Wire): string {
  if (typeof item.call_id !== 'string' || !item.call_id) throw new ApiError(400, 'invalid_tool_search', '客户端工具搜索缺少 call_id');
  return item.call_id;
}
function loadedTools(item: Wire): Wire[] {
  if (!Array.isArray(item.tools)) throw new ApiError(400, 'invalid_tool_search', '工具搜索结果缺少 tools 列表');
  return responseTools(item.tools);
}
/** Rebuild the effective tool catalog from this request only. Search results are
 * conversation state, not a process-wide cache; namespaces and custom schemas
 * must survive even when they are absent from the top-level tools list. */
function effectiveResponseTools(body: Wire): Wire[] {
  const catalog = new Map<string, Wire>();
  const add = (tool: Wire) => {
    if (tool.type === 'tool_search') searchExecution(tool);
    else if (!['function', 'custom'].includes(tool.type)) throw new ApiError(400, 'unsupported_tool', `此转换通道尚不支持托管工具：${tool.type}`);
    else if (typeof tool.name !== 'string' || !tool.name) throw new ApiError(400, 'invalid_tool', '工具缺少名称');
    const name = tool.type === 'tool_search' ? SEARCH_ALIAS : toolAlias(tool.name, tool.namespace);
    if (tool.type !== 'tool_search' && name === SEARCH_ALIAS) throw new ApiError(400, 'invalid_tool', '工具名称与协议转换保留名称冲突');
    catalog.set(name, tool);
  };
  for (const tool of responseTools(body.tools)) {
    // A deferred declaration is not callable until the client loads it.
    if (!tool.defer_loading) add(tool);
  }
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item.type === 'tool_search_output' || item.type === 'additional_tools') {
      if (item.type === 'tool_search_output') { searchExecution(item); searchCallId(item); }
      else if (item.role !== 'developer') throw new ApiError(400, 'invalid_tool', 'additional_tools 的 role 必须为 developer');
      loadedTools(item).forEach(add);
    }
  }
  return [...catalog.values()];
}
function loadedToolContent(item: Wire): string {
  return JSON.stringify({ tools: loadedTools(item).map(tool => ({ ...tool, name: toolAlias(tool.name, tool.namespace) })) });
}
export function toChat(body: Wire, from: Protocol, context: ConversionContext): Wire {
  if (from === 'chat') return { ...body };
  if (body.previous_response_id || body.conversation) throw new ApiError(400, 'full_context_required', '此转换通道需要完整历史消息，请使用无状态的完整上下文请求');
  const messages: Wire[] = [];
  const appendCall = (call: Wire) => {
    let last = messages.at(-1);
    if (!last || last.role !== 'assistant') { last = { role: 'assistant', content: null }; messages.push(last); }
    (last.tool_calls ??= []).push(call);
  };
  if (from === 'responses') {
    if (body.instructions) messages.push({ role: 'system', content: contentText(body.instructions) });
    const inputs = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input ?? [];
    let reasoning = '';
    for (const item of inputs) {
      if (item.type === 'reasoning') {
        if (item.encrypted_content) {
          try { reasoning += context.box.open(item.encrypted_content, `reasoning:${context.owner}:${context.modelId}`); }
          catch { throw new ApiError(400, 'invalid_reasoning_state', '思考上下文与当前账号或模型不匹配，请新建会话'); }
        }
      } else if (item.type === 'tool_search_call') {
        searchExecution(item);
        if (!item.arguments || typeof item.arguments !== 'object' || Array.isArray(item.arguments)) throw new ApiError(400, 'invalid_tool_search', '工具搜索参数必须是 JSON 对象');
        appendCall({ id: searchCallId(item), type: 'function', function: { name: SEARCH_ALIAS, arguments: JSON.stringify(item.arguments) } });
        if (reasoning) { messages.at(-1)!.reasoning_content = reasoning; reasoning = ''; }
      } else if (item.type === 'tool_search_output') {
        searchExecution(item);
        messages.push({ role: 'tool', tool_call_id: searchCallId(item), content: loadedToolContent(item) });
      } else if (item.type === 'additional_tools') {
        messages.push({ role: 'system', content: `Additional tools available from this point: ${loadedToolContent(item)}` });
      } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        appendCall({ id: item.call_id, type: 'function', function: { name: toolAlias(item.name, item.namespace), arguments: item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : item.arguments } });
        if (reasoning) { messages.at(-1)!.reasoning_content = reasoning; reasoning = ''; }
      } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: contentText(item.output) });
      } else if (item.type === 'message' || item.role) {
        const m: Wire = { role: item.role === 'developer' ? 'system' : item.role, content: chatContent(item.content) };
        if (reasoning && m.role === 'assistant') { m.reasoning_content = reasoning; reasoning = ''; }
        messages.push(m);
      } else throw new ApiError(400, 'unsupported_input', `当前协议转换尚不支持输入类型：${item.type}`);
    }
  } else {
    if (body.system) messages.push({ role: 'system', content: contentText(body.system) });
    for (const message of body.messages ?? []) {
      if (typeof message.content === 'string') { messages.push({ role: message.role, content: message.content }); continue; }
      const parts: Wire[] = []; const calls: Wire[] = []; let thinking = '';
      for (const part of message.content ?? []) {
        if (part.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: part.tool_use_id, content: contentText(part.content) });
        else if (part.type === 'tool_use') calls.push({ id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) } });
        else if (part.type === 'thinking') thinking += part.thinking ?? '';
        else if (part.type === 'redacted_thinking') throw new ApiError(400, 'unsupported_reasoning', '当前转换通道无法重放该加密思考块，请使用兼容原生通道');
        else parts.push(part);
      }
      if (parts.length || calls.length || thinking) messages.push({ role: message.role, content: parts.length ? chatContent(parts) : null, ...(calls.length ? { tool_calls: calls } : {}), ...(thinking ? { reasoning_content: thinking } : {}) });
    }
  }
  const tools = (from === 'responses' ? effectiveResponseTools(body) : body.tools ?? []).map((tool: Wire) => {
    if (from === 'messages') {
      if (tool.type && !['custom'].includes(tool.type)) throw new ApiError(400, 'unsupported_tool', `此通道需要原生支持的工具：${tool.type}`);
      return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } };
    }
    if (tool.type === 'tool_search') {
      searchExecution(tool);
      if (!tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) throw new ApiError(400, 'invalid_tool_search', '客户端工具搜索缺少参数 schema');
      return { type: 'function', function: { name: SEARCH_ALIAS, description: tool.description ?? 'Search for tools needed for the task. The client will return callable tool definitions.', parameters: tool.parameters } };
    }
    if (tool.type === 'function') return { type: 'function', function: { name: toolAlias(tool.name, tool.namespace), description: tool.description, parameters: tool.parameters, ...(tool.strict !== undefined ? { strict: tool.strict } : {}) } };
    if (tool.type === 'custom') {
      return { type: 'function', function: { name: toolAlias(tool.name, tool.namespace), description: `${tool.description ?? ''}\nReturn the tool input as the input string.${tool.format?.definition ? `\nRequired input grammar:\n${tool.format.definition}` : ''}`, parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false } } };
    }
    throw new ApiError(400, 'unsupported_tool', `此转换通道尚不支持托管工具：${tool.type}`);
  });
  const out: Wire = { messages, model: body.model, stream: body.stream === true };
  if (tools.length) out.tools = tools;
  if (out.stream) out.stream_options = { include_usage: true };
  for (const field of ['temperature', 'top_p', 'parallel_tool_calls', 'seed']) if (body[field] !== undefined) out[field] = body[field];
  if (body.max_tokens ?? body.max_output_tokens) out.max_tokens = body.max_tokens ?? body.max_output_tokens;
  if (body.stop_sequences) out.stop = body.stop_sequences;
  if (body.reasoning?.effort) out.reasoning_effort = body.reasoning.effort;
  if (body.thinking) out.thinking = body.thinking;
  if (body.tool_choice) {
    const c = body.tool_choice;
    out.tool_choice = typeof c === 'string' ? c : c.type === 'tool_search' ? { type: 'function', function: { name: SEARCH_ALIAS } } : c.type === 'any' ? 'required' : c.type === 'auto' ? 'auto' : c.type === 'none' ? 'none' : c.name ? { type: 'function', function: { name: toolAlias(c.name, c.namespace) } } : c;
  }
  if (body.text?.format?.type === 'json_schema') out.response_format = { type: 'json_schema', json_schema: body.text.format };
  return out;
}

export interface SSE { event?: string; data: string; raw: string }
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSE> {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  try {
    for (;;) {
      const next = await reader.read();
      buffer += decoder.decode(next.value, { stream: !next.done });
      if (buffer.length > 4 * 1024 * 1024) throw new ApiError(502, 'invalid_upstream_stream', '上游单个流式事件超过大小限制');
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const raw = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        let event: string | undefined; const data: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        yield { event, data: data.join('\n'), raw: `${raw}\n\n` };
      }
      if (next.done) break;
    }
    if (buffer.trim()) throw new ApiError(502, 'incomplete_stream', '上游流在一个事件完成前中断');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export interface OutputChunk { text: string; meaningful: boolean; terminal?: boolean; usage?: Usage; failure?: Wire; responseId?: string; incomplete?: boolean }
export const sse = (event: string | undefined, data: unknown) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

export async function* nativeStream(body: ReadableStream<Uint8Array>, protocol: Protocol, modelId: string): AsyncGenerator<OutputChunk> {
  let usage = unknownUsage(); let terminal = false;
  for await (const frame of parseSSE(body)) {
    if (!frame.data) { yield { text: frame.raw, meaningful: false }; continue; }
    if (frame.data === '[DONE]') { terminal = true; yield { text: frame.raw, meaningful: false, terminal: true, usage }; continue; }
    let data: Wire;
    try { data = JSON.parse(frame.data); } catch { throw new ApiError(502, 'invalid_upstream_stream', '上游返回了无效的流式 JSON'); }
    usage = readUsage(data, usage, protocol);
    const type = data.type ?? frame.event;
    const failure = data.error || type === 'error' || type === 'response.failed' ? data.error ?? data.response?.error ?? data : undefined;
    if (data.model) data.model = modelId;
    if (data.message?.model) data.message.model = modelId;
    if (data.response?.model) data.response.model = modelId;
    const done = type === 'message_stop' || type === 'response.completed' || type === 'response.incomplete';
    terminal ||= done;
    const meaningful = protocol === 'messages'
      ? type === 'content_block_delta' || (type === 'content_block_start' && data.content_block?.type === 'tool_use')
      : protocol === 'responses'
        ? /(?:\.delta$|output_item\.added$)/.test(type ?? '') && (type !== 'response.output_item.added' || ['function_call', 'custom_tool_call', 'tool_search_call', 'tool_search_output'].includes(data.item?.type))
        : Boolean(data.choices?.some((c: Wire) => c.delta?.content || c.delta?.reasoning_content || c.delta?.tool_calls?.length));
    yield { text: sse(frame.event, data), meaningful, terminal: done, usage, failure, responseId: data.response?.id, incomplete: type === 'response.incomplete' };
  }
  if (!terminal) throw new ApiError(502, 'incomplete_stream', '上游流提前结束，未收到完成事件');
}

/** Translates Chat Completions deltas into Messages or Responses while retaining
 * tool IDs and incremental arguments. Assembled output items are retained for the
 * terminal Responses envelope while text is emitted incrementally. */
class ChatEncoder {
  readonly responseId = id('resp');
  readonly messageId = id('msg');
  private sequence = 0;
  private items: Wire[] = [];
  private textItem?: { index: number; item: Wire; text: string };
  private reasoningItem?: { index: number; item: Wire; text: string };
  private calls = new Map<number, { index: number; item: Wire; arguments: string; custom: boolean; search: boolean }>();
  private stoppedBlocks = new Set<number>();
  private usage = unknownUsage();
  private finishReason = 'stop';
  private createdAt = Math.floor(Date.now() / 1000);
  constructor(private target: 'responses' | 'messages', private modelId: string, private original: Wire, private context: ConversionContext) {}
  private event(type: string, data: Wire): OutputChunk {
    const event = { type, ...data, ...(this.target === 'responses' ? { sequence_number: this.sequence++ } : {}) };
    return { text: sse(type, event), meaningful: /delta$/.test(type) || (type === 'content_block_start' && data.content_block.type === 'tool_use') || (type === 'response.output_item.added' && ['function_call', 'custom_tool_call', 'tool_search_call', 'tool_search_output'].includes(data.item.type)), usage: this.usage };
  }
  private envelope(status: string, output = this.items): Wire {
    return { id: this.responseId, object: 'response', created_at: this.createdAt, status, model: this.modelId,
      error: null, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
      output, parallel_tool_calls: this.original.parallel_tool_calls ?? true, tool_choice: this.original.tool_choice ?? 'auto', tools: this.original.tools ?? [],
      usage: this.usage.input === null && this.usage.output === null ? null : { input_tokens: this.usage.input ?? 0, output_tokens: this.usage.output ?? 0, total_tokens: (this.usage.input ?? 0) + (this.usage.output ?? 0), input_tokens_details: { cached_tokens: this.usage.cached ?? 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  }
  start(): OutputChunk[] {
    if (this.target === 'responses') return [this.event('response.created', { response: this.envelope('in_progress', []) }), this.event('response.in_progress', { response: this.envelope('in_progress', []) })];
    return [this.event('message_start', { message: { id: this.messageId, type: 'message', role: 'assistant', model: this.modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })];
  }
  private text(text: string, reasoning = false): OutputChunk[] {
    const events: OutputChunk[] = [];
    if (this.target === 'messages') {
      const previous = reasoning ? this.textItem : this.reasoningItem;
      if (previous && !this.stoppedBlocks.has(previous.index)) events.push(...this.stopMessageBlock(previous, !reasoning));
    }
    let ref = reasoning ? this.reasoningItem : this.textItem;
    if (ref && this.stoppedBlocks.has(ref.index)) throw new ApiError(502, 'unsupported_block_order', '上游在结束内容块后重新输出相同类型，请改用原生 Messages 通道');
    if (!ref) {
      const index = this.items.length;
      const item = this.target === 'responses'
        ? reasoning ? { id: id('rs'), type: 'reasoning', summary: [] } : { id: this.messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
        : reasoning ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' };
      this.items.push(item); ref = { index, item, text: '' };
      if (reasoning) this.reasoningItem = ref; else this.textItem = ref;
      if (this.target === 'responses') {
        events.push(this.event('response.output_item.added', { output_index: index, item: structuredClone(item) }));
        events.push(reasoning
          ? this.event('response.reasoning_summary_part.added', { item_id: item.id, output_index: index, summary_index: 0, part: { type: 'summary_text', text: '' } })
          : this.event('response.content_part.added', { item_id: item.id, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }));
      } else events.push(this.event('content_block_start', { index, content_block: structuredClone(item) }));
    }
    ref.text += text;
    if (this.target === 'responses') events.push(this.event(reasoning ? 'response.reasoning_summary_text.delta' : 'response.output_text.delta', { item_id: ref.item.id, output_index: ref.index, ...(reasoning ? { summary_index: 0 } : { content_index: 0, logprobs: [] }), delta: text }));
    else events.push(this.event('content_block_delta', { index: ref.index, delta: reasoning ? { type: 'thinking_delta', thinking: text } : { type: 'text_delta', text } }));
    return events;
  }
  private stopMessageBlock(ref: { index: number; item: Wire; text: string }, reasoning: boolean): OutputChunk[] {
    if (this.stoppedBlocks.has(ref.index)) return [];
    const events: OutputChunk[] = [];
    if (reasoning) {
      ref.item.thinking = ref.text; ref.item.signature = this.context.box.seal(ref.text, `reasoning:${this.context.owner}:${this.context.modelId}`);
      events.push(this.event('content_block_delta', { index: ref.index, delta: { type: 'signature_delta', signature: ref.item.signature } }));
    } else ref.item.text = ref.text;
    this.stoppedBlocks.add(ref.index); events.push(this.event('content_block_stop', { index: ref.index })); return events;
  }
  push(body: Wire): OutputChunk[] {
    const events: OutputChunk[] = [];
    this.usage = readUsage(body, this.usage);
    const choice = body.choices?.[0];
    if (!choice) return events;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    const delta = choice.delta ?? choice.message ?? {};
    if (delta.reasoning_content) events.push(...this.text(delta.reasoning_content, true));
    if (delta.content) events.push(...this.text(delta.content));
    if (delta.refusal) events.push(...this.text(delta.refusal));
    for (const [position, call] of (delta.tool_calls ?? []).entries()) {
      const key = call.index ?? position;
      let ref = this.calls.get(key);
      if (!ref) {
        if (!call.function?.name) throw new ApiError(502, 'invalid_tool_call', '上游工具调用缺少名称');
        const definition = this.target === 'responses' ? effectiveResponseTools(this.original).find((t: Wire) => (t.type === 'tool_search' ? SEARCH_ALIAS : toolAlias(t.name, t.namespace)) === call.function.name) : undefined;
        const custom = definition?.type === 'custom';
        const search = definition?.type === 'tool_search';
        const callId = call.id ?? id('call'); const index = this.items.length;
        const item = this.target === 'responses'
          ? search ? { type: 'tool_search_call', id: id('ts'), call_id: callId, execution: 'client', status: 'in_progress', arguments: {} } : { type: custom ? 'custom_tool_call' : 'function_call', id: id('fc'), call_id: callId, name: definition?.name ?? call.function.name, ...(definition?.namespace ? { namespace: definition.namespace } : {}), status: 'in_progress', ...(custom ? { input: '' } : { arguments: '' }) }
          : { type: 'tool_use', id: callId, name: call.function.name, input: {} };
        this.items.push(item); ref = { index, item, arguments: '', custom, search }; this.calls.set(key, ref);
        if (this.target === 'responses') events.push(this.event('response.output_item.added', { output_index: index, item: structuredClone(item) }));
      }
      const args = call.function?.arguments ?? '';
      ref.arguments += args;
      if (args && !ref.custom && !ref.search && this.target === 'responses') events.push(this.event('response.function_call_arguments.delta', { item_id: ref.item.id, output_index: ref.index, delta: args }));
    }
    return events;
  }
  finish(): OutputChunk[] {
    const events: OutputChunk[] = [];
    for (const [reasoning, ref] of [[true, this.reasoningItem], [false, this.textItem]] as const) {
      if (!ref) continue;
      if (this.target === 'responses') {
        if (reasoning) {
          ref.item.summary = [{ type: 'summary_text', text: ref.text }];
          ref.item.encrypted_content = this.context.box.seal(ref.text, `reasoning:${this.context.owner}:${this.context.modelId}`);
          events.push(this.event('response.reasoning_summary_text.done', { item_id: ref.item.id, output_index: ref.index, summary_index: 0, text: ref.text }));
          events.push(this.event('response.reasoning_summary_part.done', { item_id: ref.item.id, output_index: ref.index, summary_index: 0, part: ref.item.summary[0] }));
        } else {
          ref.item.status = 'completed'; ref.item.content = [{ type: 'output_text', text: ref.text, annotations: [], logprobs: [] }];
          events.push(this.event('response.output_text.done', { item_id: ref.item.id, output_index: ref.index, content_index: 0, text: ref.text, logprobs: [] }));
          events.push(this.event('response.content_part.done', { item_id: ref.item.id, output_index: ref.index, content_index: 0, part: ref.item.content[0] }));
        }
        events.push(this.event('response.output_item.done', { output_index: ref.index, item: ref.item }));
      } else events.push(...this.stopMessageBlock(ref, reasoning));
    }
    for (const ref of this.calls.values()) {
      let parsed: unknown;
      try { parsed = JSON.parse(ref.arguments || '{}'); } catch {
        throw new ApiError(502, 'incomplete_tool_arguments', '上游工具参数未形成完整 JSON，请检查请求是否达到输出长度上限');
      }
      if (this.target === 'responses') {
        ref.item.status = 'completed';
        if (ref.search) {
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError(502, 'invalid_tool_search_arguments', '上游工具搜索参数必须是 JSON 对象');
          ref.item.arguments = parsed;
        } else if (ref.custom) {
          const input = (parsed as Wire)?.input;
          if (typeof input !== 'string') throw new ApiError(502, 'invalid_custom_tool', '上游自定义工具调用缺少 input 文本');
          ref.item.input = input;
          events.push(this.event('response.custom_tool_call_input.delta', { item_id: ref.item.id, output_index: ref.index, delta: input }));
          events.push(this.event('response.custom_tool_call_input.done', { item_id: ref.item.id, output_index: ref.index, input }));
        } else {
          ref.item.arguments = ref.arguments || '{}';
          events.push(this.event('response.function_call_arguments.done', { item_id: ref.item.id, output_index: ref.index, name: ref.item.name, arguments: ref.item.arguments }));
        }
        events.push(this.event('response.output_item.done', { output_index: ref.index, item: ref.item }));
      } else {
        events.push(this.event('content_block_start', { index: ref.index, content_block: { type: 'tool_use', id: ref.item.id, name: ref.item.name, input: {} } }));
        events.push(this.event('content_block_delta', { index: ref.index, delta: { type: 'input_json_delta', partial_json: ref.arguments || '{}' } }));
        ref.item.input = parsed; events.push(this.event('content_block_stop', { index: ref.index }));
      }
    }
    const incomplete = this.finishReason === 'length';
    if (this.target === 'responses') events.push({ ...this.event(incomplete ? 'response.incomplete' : 'response.completed', { response: this.envelope(incomplete ? 'incomplete' : 'completed') }), terminal: true, responseId: this.responseId, incomplete });
    else {
      events.push(this.event('message_delta', { delta: { stop_reason: incomplete ? 'max_tokens' : this.calls.size ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { input_tokens: this.usage.input ?? 0, output_tokens: this.usage.output ?? 0, ...(this.usage.cached !== null ? { cache_read_input_tokens: this.usage.cached } : {}) } }));
      events.push({ ...this.event('message_stop', {}), terminal: true, incomplete });
    }
    return events;
  }
  json(): Wire {
    if (this.target === 'responses') return this.envelope(this.finishReason === 'length' ? 'incomplete' : 'completed');
    return { id: this.messageId, type: 'message', role: 'assistant', model: this.modelId, content: this.items, stop_reason: this.finishReason === 'length' ? 'max_tokens' : this.calls.size ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: this.usage.input ?? 0, output_tokens: this.usage.output ?? 0 } };
  }
  currentUsage() { return this.usage; }
}

export function convertChatJSON(body: Wire, target: 'responses' | 'messages', modelId: string, original: Wire, context: ConversionContext) {
  if (!body.choices?.length) throw new ApiError(502, 'invalid_upstream_response', '上游未返回有效回复');
  const encoder = new ChatEncoder(target, modelId, original, context);
  encoder.push(body); encoder.finish(); return encoder.json();
}
export async function* convertedChatStream(body: ReadableStream<Uint8Array>, target: 'responses' | 'messages', modelId: string, original: Wire, context: ConversionContext): AsyncGenerator<OutputChunk> {
  const encoder = new ChatEncoder(target, modelId, original, context);
  yield* encoder.start();
  let ended = false; let gotFinish = false;
  for await (const frame of parseSSE(body)) {
    if (!frame.data) { yield { text: ': heartbeat\n\n', meaningful: false }; continue; }
    if (frame.data === '[DONE]') { ended = true; break; }
    let data: Wire;
    try { data = JSON.parse(frame.data); } catch { throw new ApiError(502, 'invalid_upstream_stream', '上游返回了无效的流式 JSON'); }
    if (data.error) { yield { text: '', meaningful: false, failure: data.error, usage: readUsage(data) }; return; }
    gotFinish ||= Boolean(data.choices?.[0]?.finish_reason);
    yield* encoder.push(data);
  }
  if (!ended || !gotFinish) throw new ApiError(502, 'incomplete_stream', '上游流提前结束，未收到完整完成标记');
  yield* encoder.finish();
}
