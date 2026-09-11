import type { ModelRoute, Provider } from './types.js';

export type ModelBrand = 'zhipu' | 'deepseek';
export type ProviderBrand = ModelBrand | 'volcano';

// Presentation only: never use brand recognition to select a channel or infer capabilities.
export function providerBrand(provider?: Pick<Provider, 'endpoints'>): ProviderBrand | undefined {
  const endpoints = Object.values(provider?.endpoints ?? {}).filter(Boolean);
  if (!endpoints.length) return;
  const brands = endpoints.map(endpoint => {
    try {
      const host = new URL(endpoint!).hostname;
      if (host === 'open.bigmodel.cn') return 'zhipu';
      if (host === 'api.deepseek.com') return 'deepseek';
      if (host === 'volces.com' || host.endsWith('.volces.com')) return 'volcano';
    } catch { /* A custom or invalid address uses the neutral icon. */ }
  });
  return brands[0] && brands.every(brand => brand === brands[0]) ? brands[0] : undefined;
}

export function modelBrand(routes: Pick<ModelRoute, 'upstreamModel'>[]): ModelBrand | undefined {
  const brands = routes.map(route => {
    const code = route.upstreamModel.trim().toLowerCase().split('/').at(-1) ?? '';
    if (/^glm(?:[-_.]|$)/.test(code)) return 'zhipu';
    if (/^deepseek(?:[-_.]|$)/.test(code)) return 'deepseek';
  });
  return brands[0] && brands.every(brand => brand === brands[0]) ? brands[0] : undefined;
}
