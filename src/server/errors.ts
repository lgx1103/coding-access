import type { ApiKey, Protocol } from '../shared/types.js';
import { redact } from './security.js';

export class ApiError extends Error {
  publicError?: { code: string; message: string };
  constructor(public status: number, public code: string, message: string, public retryAfter?: number) { super(message); }
}
export function errorBody(error: ApiError, requestId?: string, protocol: Protocol = 'responses') {
  const visible = error.publicError ?? error;
  return { ...(protocol === 'messages' ? { type: 'error' } : {}), error: { type: visible.code, code: visible.code, message: visible.message }, ...(requestId ? { request_id: requestId } : {}) };
}
export function streamError(error: ApiError, protocol: Protocol, requestId: string) {
  const visible = error.publicError ?? error;
  if (protocol === 'responses') return `event: error\ndata: ${JSON.stringify({ type: 'error', code: visible.code, message: visible.message, request_id: requestId })}\n\n`;
  if (protocol === 'messages') return `event: error\ndata: ${JSON.stringify(errorBody(error, requestId, protocol))}\n\n`;
  return `data: ${JSON.stringify(errorBody(error, requestId))}\n\ndata: [DONE]\n\n`;
}
export function retryDelay(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 366 * 86400_000) : undefined;
}
export type FailureCategory = 'authentication' | 'subscription' | 'quota' | 'rate_limit' | 'configuration' | 'context_length' | 'content_policy' | 'invalid_request' | 'service';
export interface UpstreamFailure { category?: FailureCategory; status: number; code: string; message: string; retryable: boolean; scope?: string; cooldown?: number; progressive?: boolean; ambiguous?: boolean }
/** Only accept an explicit future timestamp, not arbitrary numbers in a message.
 * Zhipu's Chinese reset time is Beijing time when no offset is supplied. */
export function quotaResetDelay(message: string, now = Date.now()): number | undefined {
  if (!/重置|恢复|reset/i.test(message)) return undefined;
  const match = message.match(/\b(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})?/);
  if (!match) return undefined;
  const delay = Date.parse(`${match[1]}T${match[2]}${match[3] ?? '+08:00'}`) - now;
  return Number.isFinite(delay) && delay > 0 && delay <= 31 * 86400_000 ? delay : undefined;
}
/** Codes take precedence over HTTP status; never classify by arbitrary message text. */
export function upstreamCategory(status: number, code: string): FailureCategory {
  if (['1301', 'content_filter', 'content_policy_violation'].includes(code)) return 'content_policy';
  if (['1261', 'context_length_exceeded', 'request_too_large'].includes(code) || status === 413) return 'context_length';
  if (['InvalidSubscription', '1309', '1314'].includes(code)) return 'subscription';
  if (['1113', '1308', '1310', '1316', '1317', '1318', '1319', '1320', '1321', 'insufficient_quota'].includes(code) || status === 402) return 'quota';
  if (['1000', '1001', '1003', '1005', 'invalid_api_key', 'authentication_error'].includes(code) || status === 401) return 'authentication';
  if (['1211', '1212', '1220', '1221', '1222', '1311', '1315', 'model_not_found', 'permission_error'].includes(code) || status === 403 || status === 404) return 'configuration';
  if (['1305', 'overloaded_error', 'api_error'].includes(code)) return 'service';
  if (['1210', '1213', '1214', '1215', 'invalid_request_error', 'invalid_request'].includes(code) || status === 400 || status === 422) return 'invalid_request';
  if (status === 429 || ['1302', '1313', 'rate_limit_error'].includes(code)) return 'rate_limit';
  return 'service';
}
const publicMessages: Record<FailureCategory, string> = {
  authentication: '当前模型的服务凭证暂不可用，请联系管理员检查资源池。',
  subscription: '当前模型的订阅资源暂不可用，请联系管理员检查套餐或席位。',
  quota: '当前模型的可用额度不足，请稍后重试或联系管理员。',
  rate_limit: '当前模型请求较多，请稍后重试。',
  configuration: '当前模型的接入配置或授权不可用，请联系管理员。',
  context_length: '当前请求过长，请缩短对话、减少附件或开启新会话。',
  content_policy: '当前请求未通过模型服务的内容检查，请调整内容。',
  invalid_request: '当前请求格式或参数不受模型支持，请检查输入；持续出现时请联系管理员。',
  service: '模型服务暂时不可用，请稍后重试；持续出现时请联系管理员。',
};
/** Preserve diagnostics for the store; expose only controlled text to API callers. */
export function upstreamApiError(failure: UpstreamFailure, retryAfter?: number): ApiError {
  const category = failure.category ?? upstreamCategory(failure.status, failure.code);
  const status = category === 'quota' || category === 'rate_limit' ? 429 : failure.status;
  const error = new ApiError(status, failure.code, failure.message, retryAfter);
  error.publicError = { code: `upstream_${category}`, message: publicMessages[category] };
  return error;
}
export function classifyUpstream(status: number, body: Record<string, any>, key: ApiKey, modelId: string, retryAfter?: string | null, secrets: string[] = []): UpstreamFailure {
  const error = body?.error ?? body ?? {};
  const code = redact(String(error.code ?? error.type ?? `http_${status}`), secrets).slice(0, 120);
  const message = redact(String(error.message ?? `上游返回 ${status}`), secrets);
  const category = upstreamCategory(status, code);
  const base = { status, code, message, category };
  const accountScope = key.rateScope === 'group' && key.group ? `group:${key.providerId}:${key.group}` : `key:${key.id}`;
  const rateScope = key.rateScope === 'model' ? `key-model:${key.id}:${modelId}` : accountScope;
  const delay = retryDelay(retryAfter ?? null);
  if (category === 'subscription' || category === 'quota') {
    const reset = delay ?? quotaResetDelay(message);
    return { ...base, status: category === 'quota' ? 429 : 503, retryable: true, scope: accountScope, cooldown: reset ?? 300_000, progressive: reset === undefined };
  }
  if (category === 'authentication') return { ...base, status: 503, retryable: true, scope: `invalid:${key.id}`, cooldown: 10 * 365 * 86400_000 };
  if (category === 'configuration') return { ...base, status: 503, retryable: true, scope: `key-model:${key.id}:${modelId}`, cooldown: delay ?? 300_000 };
  if (category === 'rate_limit') return { ...base, status: 429, retryable: true, scope: rateScope, cooldown: delay ?? 15_000 + Math.random() * 5000 };
  if (category === 'content_policy' || category === 'context_length' || category === 'invalid_request') return { ...base, status: status === 413 || status === 422 ? status : 400, retryable: false };
  if ([502, 503, 504, 529].includes(status) || ['1305', 'overloaded_error'].includes(code)) return { ...base, status: status >= 500 ? status : 503, retryable: true, scope: `provider-model:${key.providerId}:${modelId}`, cooldown: delay ?? 10_000 };
  if (status >= 500 || code === 'api_error') return { ...base, status: status >= 500 ? status : 503, retryable: true, scope: rateScope, cooldown: delay ?? 5000 };
  // Unknown client errors are not safe to retry blindly.
  return { ...base, status: status >= 400 ? status : 502, retryable: false };
}
