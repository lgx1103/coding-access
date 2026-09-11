import { setTimeout as delay } from 'node:timers/promises';
import type { ApiKey, EmployeeModel, Model, Protocol, Provider, Usage } from '../shared/types.js';
import { Store, type AttemptRecord, type User } from './db.js';
import { AdaptivePool, FairQueue, type Candidate, type Lease } from './scheduler.js';
import { ApiError, classifyUpstream, upstreamApiError, streamError, type UpstreamFailure } from './errors.js';
import { convertedChatStream, convertChatJSON, hasImage, nativeStream, readUsage, toChat, unknownUsage, type OutputChunk, type Wire } from './protocols.js';
import { id, redact, SecretBox } from './security.js';
import { modelBrand } from '../shared/brand.js';
import { agentProtocol } from '../shared/types.js';
import { canUseModel } from '../shared/model-access.js';

export interface GatewayOptions { requestDeadlineMs?: number; streamIdleMs?: number; capacity?: number; perEmployee?: number; fetch?: typeof fetch }
export interface GatewayResult { requestId: string; json?: Wire; stream?: AsyncGenerator<string> }
interface Channel { key: ApiKey; provider: Provider; upstreamModel: string; protocol: Protocol; candidate: Candidate; vision?: boolean }

function endpoint(provider: Provider, protocol: Protocol) {
  const base = new URL(provider.endpoints[protocol]!);
  base.pathname = base.pathname.replace(/\/$/, '') + (protocol === 'messages' ? '/v1/messages' : protocol === 'responses' ? '/responses' : '/chat/completions');
  return base.toString();
}
export class Gateway {
  readonly pool = new AdaptivePool();
  private recovering = new Set<string>();
  readonly queue: FairQueue;
  readonly options: Required<GatewayOptions>;
  constructor(readonly store: Store, readonly box: SecretBox, options: GatewayOptions = {}) {
    this.options = { requestDeadlineMs: 90_000, streamIdleMs: 180_000, capacity: 16, perEmployee: 3, fetch, ...options };
    this.queue = new FairQueue(this.options.capacity, this.options.perEmployee);
  }
  permitted(user: User, model: Model) { return canUseModel(user, model); }
  channels(model: Model, protocol: Protocol, vision = false): Channel[] {
    const keys = this.store.keys(); const channels: Channel[] = [];
    if (vision && model.capabilityMode === 'unified' && model.vision === false) return channels;
    for (const route of model.routes) {
      const provider = this.store.provider(route.providerId);
      if (!provider?.enabled || (vision && route.vision === false)) continue;
      if (route.contextWindow !== undefined && model.contextWindow !== undefined && route.contextWindow < model.contextWindow) continue;
      const upstreamProtocol = provider.endpoints[protocol] ? protocol : provider.endpoints.chat ? 'chat' : undefined;
      if (!upstreamProtocol) continue;
      for (const key of keys) {
        if (key.providerId !== provider.id || !key.enabled || (key.models.length && !key.models.includes(model.id))) continue;
        channels.push({ key, provider, upstreamModel: route.upstreamModel, protocol: upstreamProtocol, vision: model.capabilityMode === 'unified' ? model.vision : route.vision,
          candidate: { id: key.id, providerId: provider.id, providerWeight: route.weight, keyWeight: key.weight, maxConcurrent: key.maxConcurrent, ...(key.rateScope === 'group' && key.group ? { group: `${provider.id}:${key.group}` } : {}) } });
      }
    }
    return channels;
  }
  catalog(user: User, agent?: string): EmployeeModel[] {
    const protocol = agentProtocol(agent);
    return this.store.models().filter(m => this.permitted(user, m) && (!agent || m.agents.includes(agent as any))).map(model => {
      const channels = this.channels(model, protocol);
      const ready = channels.filter(c => !this.store.blocked(c.key, model.id));
      const known = ready.some(c => this.store.lastSuccess(c.key.id));
      const busy = ready.length && ready.every(c => this.pool.active(c.key.id) >= c.key.maxConcurrent);
      const vision = model.capabilityMode === 'unified' ? model.vision : channels.some(channel => channel.vision === true) ? true : channels.length && channels.every(channel => channel.vision === false) ? false : undefined;
      return { id: model.id, name: model.name, description: model.description, brand: modelBrand(model.routes), agents: model.agents, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, vision, status: !ready.length ? 'unavailable' : busy ? 'busy' : known ? 'available' : 'unknown', updatedAt: Date.now() };
    });
  }
  private recordFailure(channel: Channel, model: Model, failure: UpstreamFailure) {
    if (failure.progressive && failure.scope && failure.cooldown) {
      const previous = this.store.db.prepare('SELECT until_ms,updated_at,reason FROM states WHERE scope=?').get(failure.scope);
      if (previous?.reason === failure.code) failure.cooldown = Math.min(3600_000, Math.max(failure.cooldown, 2 * (Number(previous.until_ms) - Number(previous.updated_at))));
    }
    if (failure.scope && failure.cooldown !== undefined) this.store.block(failure.scope, Date.now() + failure.cooldown, failure.code);
    if (failure.retryable) this.store.event(failure.scope?.startsWith('provider') ? channel.provider.id : channel.key.id, failure.code, failure.message);
  }
  async execute(rawCredential: string, body: Wire, protocol: Protocol, agent: string, signal = new AbortController().signal, forwardedHeaders: Record<string, string> = {}, targetKey?: string): Promise<GatewayResult> {
    const auth = this.store.authenticate(rawCredential, 'api');
    if (!auth || auth.user.mustChangePassword) throw new ApiError(401, 'invalid_api_key', '公司访问凭证无效或已撤销，请重新登录客户端');
    if (typeof body.model !== 'string') throw new ApiError(400, 'invalid_model', '请指定管理端发布的模型');
    const model = this.store.model(body.model);
    if (!model) throw new ApiError(404, 'model_not_found', '模型不存在，请刷新模型列表');
    if (!model.enabled) throw new ApiError(403, 'model_disabled', '该模型已被管理员停用，请在客户端选择其他模型');
    if (!this.permitted(auth.user, model)) throw new ApiError(403, 'model_forbidden', '当前账号没有使用该模型的权限');
    const agentId = agent === 'zcode' ? 'zcode' : protocol === 'messages' ? 'claude-code' : agent === 'codex' ? 'codex' : agent === 'codex-desktop' ? 'codex-desktop' : 'codex-cli';
    const compatibleAgent = agentId === 'codex' ? model.agents.some(a => a === 'codex-cli' || a === 'codex-desktop') : model.agents.includes(agentId);
    if (!compatibleAgent) throw new ApiError(400, 'agent_not_enabled', '管理员尚未为此工具开放该模型');
    if (body.background === true) throw new ApiError(400, 'background_unsupported', '请使用前台流式请求');
    const requestedOutput = body.max_output_tokens ?? body.max_tokens;
    if (requestedOutput !== undefined && (!Number.isInteger(requestedOutput) || requestedOutput < 1)) throw new ApiError(400, 'output_limit', '输出长度必须是正整数');
    if (requestedOutput !== undefined && model.maxOutputTokens !== undefined && requestedOutput > model.maxOutputTokens) throw new ApiError(400, 'output_limit', `输出长度应在 1 到 ${model.maxOutputTokens} 之间`);
    const requestId = this.store.beginRequest(auth.user.id, model.id, agentId, auth.credentialId);
    const startedAt = Date.now();
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    let timeout = setTimeout(() => controller.abort(new Error('deadline')), this.options.requestDeadlineMs);
    let admitted: (() => void) | undefined;
    let finished = false;
    const finish = (status: string, code?: string, message?: string, firstTokenMs?: number) => {
      if (finished) return; finished = true;
      clearTimeout(timeout); signal.removeEventListener('abort', cancel); admitted?.();
      this.store.finishRequest(requestId, status, code, message, firstTokenMs);
    };
    const excluded = new Set<string>(); let lastFailure: UpstreamFailure | undefined;
    // This is a workload estimate, not the vendor's billing or remaining quota.
    const estimatedWork = Math.max(1, Math.ceil(JSON.stringify(body.input ?? body.messages ?? '').length / 4));
    const context = { box: this.box, owner: auth.user.id, modelId: model.id };
    try {
      admitted = await this.queue.enter(auth.user.id, controller.signal);
      for (;;) {
        if (controller.signal.aborted) throw new ApiError(signal.aborted ? 499 : 504, signal.aborted ? 'cancelled' : 'wait_timeout', signal.aborted ? '请求已取消' : '请求等待超时，部分资源可能尚未完成尝试');
        const current = this.store.authenticate(rawCredential, 'api');
        const currentModel = this.store.model(model.id);
        if (!current || !currentModel || !this.permitted(current.user, currentModel)) throw new ApiError(403, 'access_revoked', '账号或模型访问权限已被撤销');
        if (!(agentId === 'codex' ? currentModel.agents.some(a => a === 'codex-cli' || a === 'codex-desktop') : currentModel.agents.includes(agentId))) throw new ApiError(403, 'agent_not_enabled', '管理员已停止为此工具开放该模型');
        let channels = this.channels(currentModel, protocol, hasImage(body));
        if (targetKey) channels = channels.filter(c => c.key.id === targetKey);
        if (body.previous_response_id) {
          const route = this.store.db.prepare('SELECT key_id FROM response_routes WHERE id=? AND user_id=? AND model_id=?').get(body.previous_response_id, auth.user.id, model.id) as { key_id: string } | undefined;
          if (!route) throw new ApiError(400, 'full_context_required', '未找到该会话的上游关联，请发送完整历史消息');
          channels = channels.filter(c => c.key.id === route.key_id && c.protocol === 'responses');
        }
        if (!channels.length) throw new ApiError(503, 'no_compatible_channel', '当前模型没有满足工具、上下文或图片能力的接入通道');
        const ready = channels.filter(c => !excluded.has(c.key.id) && !this.store.blocked(c.key, model.id));
        if (!ready.length) {
          const blocked = channels.map(c => this.store.blocked(c.key, model.id)).filter(Boolean);
          const nextAt = blocked.length ? Math.min(...blocked.map(s => s!.until_ms as number)) : undefined;
          const message = lastFailure ? `当前模型暂时没有可用通道。${lastFailure.message}` : '当前模型的兼容通道均处于冷却、额度耗尽或凭证异常状态';
          this.store.event(model.id, 'no_available_channel', message);
          const failure: UpstreamFailure = lastFailure ?? { status: blocked.some(s => /rate|1302|429/.test(String(s!.reason))) ? 429 : 503, code: String(blocked[0]?.reason ?? 'no_available_channel'), message, retryable: true };
          throw upstreamApiError(failure, nextAt ? Math.max(1, Math.ceil((nextAt - Date.now()) / 1000)) : undefined);
        }
        const available = ready.filter(c => !this.store.recoveryScopes(c.key, model.id).some(scope => this.recovering.has(scope)));
        const lease = this.pool.acquire(available.map(c => c.candidate), estimatedWork);
        if (!lease) { await delay(40, undefined, { signal: controller.signal }); continue; }
        const channel = ready.find(c => c.key.id === lease.candidate.id)!;
        const recovering = this.store.recoveryScopes(channel.key, model.id); recovering.forEach(scope => this.recovering.add(scope));
        let secret: string;
        try { secret = this.box.open(channel.key.encryptedSecret); }
        catch { recovering.forEach(scope => this.recovering.delete(scope)); lease.release(0); throw new ApiError(503, 'key_decryption_failed', '服务端密钥解密失败，请管理员检查主密钥与备份是否匹配'); }
        const attempt: AttemptRecord = { id: id('try'), requestId, providerId: channel.provider.id, keyId: channel.key.id, startedAt: Date.now(), status: 'running', ...unknownUsage() };
        this.store.attempt(attempt);
        let response: Response | undefined;
        let usage = unknownUsage();
        let released = false;
        const endAttempt = (status: string, code?: string, message?: string, ambiguous = false) => {
          if (released) return; released = true;
          recovering.forEach(scope => this.recovering.delete(scope));
          this.store.attempt({ ...attempt, ...usage, finishedAt: Date.now(), status, code, message, httpStatus: response?.status, ambiguous });
          lease.release(usage.input !== null || usage.output !== null ? (usage.input ?? 0) + (usage.output ?? 0) : status === 'success' ? estimatedWork : ambiguous ? estimatedWork : 0);
        };
        try {
          const payload = channel.protocol === protocol ? { ...body } : toChat(body, protocol, context);
          const sent: Wire = { ...channel.provider.defaults, ...payload, model: channel.upstreamModel };
          if (channel.protocol === 'responses') sent.store = false;
          if (channel.protocol === 'chat' && sent.stream) sent.stream_options = { include_usage: true };
          const headers: Record<string, string> = { ...channel.provider.headers, 'content-type': 'application/json' };
          if (channel.protocol === 'messages') for (const [name, value] of Object.entries(forwardedHeaders)) if (name.toLowerCase().startsWith('anthropic-')) headers[name.toLowerCase()] = value;
          if (channel.provider.auth === 'x-api-key') headers['x-api-key'] = secret;
          else headers.authorization = `Bearer ${secret}`;
          if (channel.protocol === 'messages') headers['anthropic-version'] ??= '2023-06-01';
          response = await this.options.fetch(endpoint(channel.provider, channel.protocol), { method: 'POST', headers, body: JSON.stringify(sent), signal: controller.signal, redirect: 'error' });
          if (!response.ok) {
            const raw = await response.text(); let error: Wire;
            try { error = JSON.parse(raw); } catch { error = { message: `上游返回 HTTP ${response.status}` }; }
            usage = readUsage(error, undefined, channel.protocol);
            const failure = classifyUpstream(response.status, error, channel.key, model.id, response.headers.get('retry-after'), [secret, rawCredential]);
            endAttempt('error', failure.code, failure.message); this.recordFailure(channel, model, failure); lastFailure = failure;
            if (!failure.retryable) throw upstreamApiError(failure);
            excluded.add(channel.key.id); continue;
          }
          if (!body.stream) {
            const json = await response.json() as Wire;
            usage = readUsage(json, undefined, channel.protocol);
            if (json.error) {
              const failure = classifyUpstream(Number(json.error.status) || (/rate|1302/.test(String(json.error.code ?? json.error.type)) ? 429 : 502), json, channel.key, model.id, response.headers.get('retry-after'), [secret, rawCredential]);
              endAttempt('error', failure.code, failure.message); this.recordFailure(channel, model, failure); lastFailure = failure;
              if (!failure.retryable) throw upstreamApiError(failure);
              excluded.add(channel.key.id); continue;
            }
            const output = channel.protocol === protocol ? { ...json, model: model.id } : convertChatJSON(json, protocol as 'messages' | 'responses', model.id, body, context);
            endAttempt('success'); this.store.success(channel.key, model.id); this.store.resolveEvent(model.id);
            if (protocol === 'responses' && output.id && channel.protocol === 'responses') this.saveResponseRoute(output.id, auth.user.id, model.id, channel.key.id);
            finish(output.status === 'incomplete' ? 'incomplete' : 'success', undefined, undefined, Date.now() - startedAt);
            return { requestId, json: output };
          }
          if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new ApiError(502, 'stream_format', '上游未返回所需的 SSE 流');
          const generator = channel.protocol === protocol ? nativeStream(response.body, protocol, model.id) : convertedChatStream(response.body, protocol as 'messages' | 'responses', model.id, body, context);
          const prelude: OutputChunk[] = []; let first: IteratorResult<OutputChunk>; let buffered = 0;
          for (;;) {
            first = await generator.next();
            if (first.done) throw new ApiError(502, 'empty_stream', '上游未返回完整输出');
            usage = first.value.usage ?? usage;
            if (first.value.failure) {
              const error = first.value.failure;
              const failure = classifyUpstream(Number(error.status) || (/rate|1302/.test(String(error.code ?? error.type)) ? 429 : 503), error, channel.key, model.id, response.headers.get('retry-after'), [secret, rawCredential]);
              await generator.return(undefined); endAttempt('error', failure.code, failure.message); this.recordFailure(channel, model, failure); lastFailure = failure;
              if (!failure.retryable) throw upstreamApiError(failure);
              excluded.add(channel.key.id); break;
            }
            prelude.push(first.value); buffered += first.value.text.length;
            if (first.value.meaningful || first.value.terminal) break;
            if (buffered > 256 * 1024) throw new ApiError(502, 'stream_prelude_limit', '上游在正文输出前返回了过多事件');
          }
          if (excluded.has(channel.key.id)) continue;
          clearTimeout(timeout);
          const firstTokenMs = Date.now() - startedAt;
          const self = this;
          async function* output(): AsyncGenerator<string> {
            let complete = false; let incomplete = false; let responseId: string | undefined;
            const observe = (chunk: OutputChunk) => {
              clearTimeout(timeout); timeout = setTimeout(() => controller.abort(new Error('stream_idle')), self.options.streamIdleMs);
              usage = chunk.usage ?? usage; complete ||= Boolean(chunk.terminal); incomplete ||= Boolean(chunk.incomplete); responseId = chunk.responseId ?? responseId;
              if (chunk.failure) throw upstreamApiError({ status: 502, code: String(chunk.failure.code ?? chunk.failure.type ?? 'stream_error'), message: redact(String(chunk.failure.message ?? '上游输出中断'), [secret, rawCredential]), retryable: false });
            };
            try {
              for (const chunk of prelude) { observe(chunk); yield chunk.text; }
              for await (const chunk of generator) { observe(chunk); yield chunk.text; }
              if (!complete) throw new ApiError(502, 'incomplete_stream', '上游输出提前中断');
              endAttempt(incomplete ? 'incomplete' : 'success'); self.store.success(channel.key, context.modelId); self.store.resolveEvent(context.modelId);
              if (responseId && protocol === 'responses' && channel.protocol === 'responses') self.saveResponseRoute(responseId, context.owner, context.modelId, channel.key.id);
              finish(incomplete ? 'incomplete' : 'success', undefined, undefined, firstTokenMs);
            } catch (err) {
              const error = err instanceof ApiError ? err : new ApiError(signal.aborted ? 499 : 502, signal.aborted ? 'cancelled' : 'stream_interrupted', signal.aborted ? '请求已取消' : '输出中断，请检查网络或稍后重试');
              endAttempt('interrupted', error.code, error.message, true); finish(signal.aborted ? 'cancelled' : 'error', error.publicError?.code ?? error.code, error.publicError?.message ?? error.message, firstTokenMs);
              if (!signal.aborted) yield streamError(error, protocol, requestId);
            } finally {
              controller.abort(); await generator.return(undefined).catch(() => {});
              if (!finished) { endAttempt('cancelled', 'cancelled', '客户端停止读取输出', true); finish('cancelled', 'cancelled', '客户端停止读取输出', firstTokenMs); }
            }
          }
          return { requestId, stream: output() };
        } catch (err) {
          const cause = (err as { cause?: { code?: string } }).cause?.code;
          const neverConnected = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(cause ?? '');
          if (!released) endAttempt('error', err instanceof ApiError ? err.code : 'upstream_connection', redact(err instanceof Error ? err.message : '上游连接异常', [secret, rawCredential]), !(err instanceof ApiError) && !neverConnected);
          if (err instanceof ApiError) throw err;
          if (neverConnected && !controller.signal.aborted) {
            lastFailure = { status: 502, code: 'upstream_unreachable', message: '上游连接失败', retryable: true };
            excluded.add(channel.key.id); continue;
          }
          throw new ApiError(controller.signal.aborted ? 504 : 502, controller.signal.aborted ? 'wait_timeout' : 'upstream_connection', controller.signal.aborted ? '请求等待超时，上游执行结果尚不确定' : '上游连接中断，执行结果尚不确定');
        }
      }
    } catch (err) {
      controller.abort();
      const error = err instanceof ApiError ? err : new ApiError(signal.aborted ? 499 : 500, signal.aborted ? 'cancelled' : 'server_error', signal.aborted ? '请求已取消' : '公司服务处理异常，请稍后重试或向管理员提供请求编号');
      finish(signal.aborted ? 'cancelled' : 'error', error.publicError?.code ?? error.code, error.publicError?.message ?? error.message);
      (error as ApiError & { requestId: string }).requestId = requestId;
      throw error;
    }
  }
  private saveResponseRoute(responseId: string, userId: string, modelId: string, keyId: string) {
    this.store.db.prepare('INSERT OR REPLACE INTO response_routes VALUES(?,?,?,?,?)').run(responseId, userId, modelId, keyId, Date.now());
  }
}
