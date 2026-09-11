import type { ModelRoute, Provider } from './types.js';

export interface ModelCapabilityProfile {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens?: number;
  vision: boolean;
  sources: string[];
  checkedAt: string;
}

const checkedAt = '2026-09-06';
const profiles: Record<string, ModelCapabilityProfile[]> = {
  zhipu: ['glm-5.3', 'glm-5.3-flash'].map(id => ({
    id, name: id === 'glm-5.3' ? 'GLM-5.3' : 'GLM-5.3-Flash', contextWindow: 1_000_000,
    maxOutputTokens: 131_072, vision: id.endsWith('-flash'), checkedAt,
    sources: ['https://docs.bigmodel.cn/cn/coding-plan/latest-model', 'https://docs.bigmodel.cn/cn/guide/start/concept-param'],
  })),
  volcano: ['glm-5.3', 'glm-5.3-flash'].map(id => ({
    id, name: id === 'glm-5.3' ? 'GLM-5.3' : 'GLM-5.3-Flash', contextWindow: 1_024_000,
    // The official plan says 128k maximum; its exact integer is not established.
    // The 65536 in the OpenCode example is a configuration value, not that maximum.
    vision: id.endsWith('-flash'), checkedAt,
    sources: ['https://docs.volcengine.com/docs/82379/1925114?lang=zh', 'https://docs.volcengine.com/docs/82379/2188958?lang=zh'],
  })),
  deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro'].map(id => ({
    id, name: id.endsWith('-pro') ? 'DeepSeek V4 Pro' : 'DeepSeek V4 Flash', contextWindow: 1_000_000,
    maxOutputTokens: 384_000, vision: false, checkedAt,
    sources: ['https://api-docs.deepseek.com/quick_start/agent_integrations/pi_mono/', 'https://api-docs.deepseek.com/guides/vision/'],
  })),
};

function family(provider?: Provider): string | undefined {
  if (!provider) return;
  const entries = Object.entries(provider.endpoints).filter((entry): entry is [string, string] => Boolean(entry[1]));
  const endpoints = entries.map(([, value]) => value);
  if (!endpoints.length) return;
  const urls: URL[] = [];
  try { for (const value of endpoints) urls.push(new URL(value)); } catch { return; }
  if (urls.some(url => url.protocol !== 'https:' || url.port || url.username || url.password)) return;
  if (urls.every((url, index) => url.hostname === 'open.bigmodel.cn' && (/^\/api\/(coding\/paas\/v4|anthropic)(\/|$)/.test(url.pathname) || (entries[index][0] === 'responses' && /^\/api\/v1\/?$/.test(url.pathname))))) return 'zhipu';
  if (urls.every(url => url.hostname === 'ark.cn-beijing.volces.com' && /^\/api\/coding(\/|$)/.test(url.pathname))) return 'volcano';
  if (urls.every(url => url.hostname === 'api.deepseek.com' && /^(\/|\/v1\/?|\/anthropic\/?)$/.test(url.pathname))) return 'deepseek';
}

export function profilesForProvider(provider?: Provider): ModelCapabilityProfile[] {
  return profiles[family(provider) ?? ''] ?? [];
}
export function profileForModel(provider: Provider | undefined, upstreamModel: string) {
  return profilesForProvider(provider).find(profile => profile.id === upstreamModel.trim().toLowerCase());
}

export function resolveModelCapabilities<T extends { routes: ModelRoute[]; contextWindow?: number; maxOutputTokens?: number }>(model: T, providers: Provider[]): T {
  const matched = model.routes.map(route => profileForModel(providers.find(provider => provider.id === route.providerId), route.upstreamModel));
  const routes = model.routes.map((route, index) => ({ ...route, contextWindow: matched[index]?.contextWindow, vision: matched[index]?.vision }));
  const commonMinimum = (values: (number | undefined)[]) => values.length && values.every(value => value !== undefined) ? Math.min(...values as number[]) : undefined;
  return { ...model, routes, contextWindow: commonMinimum(matched.map(profile => profile?.contextWindow)), maxOutputTokens: commonMinimum(matched.map(profile => profile?.maxOutputTokens)) };
}

// Convert the old two-level capability form once; explicit model limits win.
// Retain legacy route constraints so upgrading never enables an excluded route.
export function unifyModelCapabilities<T extends { routes: ModelRoute[]; contextWindow?: number; maxOutputTokens?: number; vision?: boolean; capabilityMode?: string }>(model: T, providers: Provider[]): T {
  if (model.capabilityMode === 'unified') return model;
  const effective = model.capabilityMode === 'automatic' ? resolveModelCapabilities(model, providers) : model;
  const limits = effective.routes.map(route => route.contextWindow);
  const contextWindow = effective.contextWindow ?? (limits.length && limits.every(n => n !== undefined) ? Math.min(...limits as number[]) : undefined);
  const vision = effective.vision ?? (effective.routes.some(r => r.vision === false) ? false : effective.routes.length && effective.routes.every(r => r.vision === true) ? true : undefined);
  return { ...effective, capabilityMode: 'unified', contextWindow, vision };
}
