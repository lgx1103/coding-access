import { expect, test } from 'vitest';
import { profilesForProvider, resolveModelCapabilities } from '../src/shared/model-capabilities.js';
import type { Provider } from '../src/shared/types.js';

const zhipu: Provider = {
  id: 'zhipu', name: '智谱', product: 'Coding Plan', enabled: true,
  endpoints: {
    messages: 'https://open.bigmodel.cn/api/anthropic',
    chat: 'https://open.bigmodel.cn/api/coding/paas/v4',
    responses: 'https://open.bigmodel.cn/api/v1',
  },
  auth: 'bearer', headers: {}, defaults: {}, createdAt: 0,
};

const flashModel = {
  contextWindow: 128000, maxOutputTokens: 8192,
  routes: [{ providerId: zhipu.id, upstreamModel: 'glm-5.3-flash', weight: 2, contextWindow: 128000, vision: false }],
};

test('official Zhipu Coding Plan keeps automatic model capabilities when Codex Responses is configured', () => {
  expect(profilesForProvider(zhipu).map(profile => profile.id)).toContain('glm-5.3-flash');
  expect(resolveModelCapabilities(flashModel, [zhipu])).toMatchObject({
    contextWindow: 1000000, maxOutputTokens: 131072,
    routes: [{ providerId: zhipu.id, upstreamModel: 'glm-5.3-flash', contextWindow: 1000000, vision: true }],
  });
});

test.each(['messages', 'chat', 'responses'] as const)('a custom %s endpoint prevents applying official capabilities to the whole connection', protocol => {
  const custom = { ...zhipu, endpoints: { ...zhipu.endpoints, [protocol]: 'https://relay.example.test/v1' } };
  expect(profilesForProvider(custom)).toEqual([]);
  const resolved = resolveModelCapabilities(flashModel, [custom]);
  expect(resolved.contextWindow).toBeUndefined();
  expect(resolved.maxOutputTokens).toBeUndefined();
  expect(resolved.routes[0].contextWindow).toBeUndefined();
  expect(resolved.routes[0].vision).toBeUndefined();
  expect(resolved.routes[0]).toMatchObject({ providerId: zhipu.id, upstreamModel: 'glm-5.3-flash', weight: 2 });
});

test('a Zhipu and Volcano pool uses their common context and leaves an unverified output limit unknown', () => {
  const volcano: Provider = {
    ...zhipu, id: 'volcano', name: '火山方舟', endpoints: {
      messages: 'https://ark.cn-beijing.volces.com/api/coding',
      chat: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      responses: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    },
  };
  const resolved = resolveModelCapabilities({
    ...flashModel,
    routes: [...flashModel.routes, { ...flashModel.routes[0], providerId: volcano.id, weight: 1 }],
  }, [zhipu, volcano]);
  expect(resolved.contextWindow).toBe(1000000);
  expect(resolved.routes).toMatchObject([
    { providerId: zhipu.id, contextWindow: 1000000, vision: true, weight: 2 },
    { providerId: volcano.id, contextWindow: 1024000, vision: true, weight: 1 },
  ]);
  // Neither Zhipu's 131072 maximum nor Volcano's 65536 example proves the pool's maximum.
  expect(resolved.maxOutputTokens).toBeUndefined();
});
