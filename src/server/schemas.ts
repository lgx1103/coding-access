import { z } from 'zod';
import { ApiError } from './errors.js';
import { AGENT_IDS } from '../shared/types.js';
import { PASSWORD_MIN_LENGTH } from '../shared/password-policy.js';

const name = z.string().trim().min(1).max(100);
export const slug = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/);
export const agentId = z.enum(AGENT_IDS);
export const password = z.string().min(PASSWORD_MIN_LENGTH, `密码至少 ${PASSWORD_MIN_LENGTH} 个字符`).max(200);
export const loginSchema = z.object({ username: z.string().trim().min(1).max(80), password: z.string().min(1).max(200), client: z.enum(['browser', 'desktop']).default('browser'), device: z.string().max(128).default('browser') });
export const userSchema = z.object({ username: slug, name, role: z.enum(['admin', 'employee']).default('employee'), password });
export const updateUserSchema = z.object({ name, enabled: z.boolean(), role: z.enum(['admin', 'employee']) });
export const providerSchema = z.object({
  name, product: z.string().trim().max(100).default('自定义接入'), enabled: z.boolean().default(true),
  endpoints: z.object({ messages: z.string().url().optional(), chat: z.string().url().optional(), responses: z.string().url().optional() }).refine(e => Object.keys(e).length > 0, '至少配置一个接口'),
  auth: z.enum(['bearer', 'x-api-key']).default('bearer'), headers: z.record(z.string(), z.string().max(2000)).default({}), defaults: z.record(z.string(), z.unknown()).default({}),
});
const modelFieldsSchema = z.object({
  name, description: z.string().max(500).default(''), enabled: z.boolean().default(false), agents: z.array(agentId).min(1),
  vision: z.boolean().optional(),
  capabilityMode: z.enum(['automatic', 'manual', 'unified']).optional(),
  audience: z.discriminatedUnion('type', [z.object({ type: z.literal('all') }), z.object({ type: z.literal('selected'), userIds: z.array(slug).max(10000).refine(ids => new Set(ids).size === ids.length, '指定成员不能重复') })]).optional(),
  contextWindow: z.number().int().min(1024).max(4_000_000).optional(), maxOutputTokens: z.number().int().min(1).max(512000).optional(),
  routes: z.array(z.object({ providerId: slug, upstreamModel: z.string().trim().min(1).max(200), weight: z.number().min(0.01).max(1000), vision: z.boolean().optional(), contextWindow: z.number().int().min(1024).max(4_000_000).optional() })).min(1),
});
const uniqueModelProviders = (model: z.infer<typeof modelFieldsSchema>) => new Set(model.routes.map(route => route.providerId)).size === model.routes.length;
export const createModelSchema = modelFieldsSchema.refine(uniqueModelProviders, '同一模型中接入不能重复');
export const modelSchema = modelFieldsSchema.extend({ id: slug }).refine(uniqueModelProviders, '同一模型中接入不能重复');
export const keySchema = z.object({ providerId: slug, name, secret: z.string().trim().min(4).max(16000), models: z.array(slug).default([]), maxConcurrent: z.number().int().min(1).max(100).default(1), weight: z.number().min(0.01).max(1000).default(1), rateScope: z.enum(['key', 'model', 'group']).default('key'), group: z.string().max(100).default('') }).refine(k => k.rateScope !== 'group' || k.group.trim().length > 0, '共享限流组需要填写组名');
export const keyUpdateSchema = z.object({ providerId: slug.optional(), name, enabled: z.boolean(), models: z.array(slug), maxConcurrent: z.number().int().min(1).max(100), weight: z.number().min(0.01).max(1000), rateScope: z.enum(['key', 'model', 'group']), group: z.string().max(100), secret: z.string().trim().min(4).max(16000).optional() }).refine(k => k.rateScope !== 'group' || k.group.trim().length > 0, '共享限流组需要填写组名');
export function validateEndpoint(value: string, allowInsecure = false) {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new ApiError(400, 'invalid_endpoint', '接口地址不能包含用户名、密码或片段');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (local || allowInsecure))) throw new ApiError(400, 'insecure_endpoint', '接口需要 HTTPS；本机演示允许 localhost HTTP');
}
