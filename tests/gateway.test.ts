import { afterEach, describe, expect, test } from 'vitest';
import { classifyUpstream } from '../src/server/errors.js';
import { Gateway } from '../src/server/gateway.js';
import { createApp } from '../src/server/app.js';
import { chatSSE, completion, fixture, textChunks } from './helpers.js';
import type { Store } from '../src/server/db.js';

const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); });
async function setup(fetcher: typeof fetch) { const f = await fixture(); stores.push(f.store); return { ...f, gateway: new Gateway(f.store, f.box, { fetch: fetcher, requestDeadlineMs: 1000 }) }; }

describe('gateway contracts', () => {
  test('unknown capacity uses the provider defaults and only known limits reject output requests', async () => {
    const sent: Record<string, unknown>[] = [];
    const f = await setup(async (_, init) => { sent.push(JSON.parse(String(init?.body))); return Response.json(completion()); });
    f.store.saveModel({ ...f.model, contextWindow: undefined, maxOutputTokens: undefined, routes: f.model.routes.map(route => ({ ...route, contextWindow: undefined, vision: undefined })) });
    await f.gateway.execute(f.apiKey, { model: f.model.id, input: 'hello', max_output_tokens: 20000 }, 'responses', 'codex-cli');
    expect(sent[0].max_tokens).toBe(20000);
    await f.gateway.execute(f.apiKey, { model: f.model.id, input: 'hello' }, 'responses', 'codex-cli');
    expect(sent[1]).not.toHaveProperty('max_tokens');
    await expect(f.gateway.execute(f.apiKey, { model: f.model.id, input: 'hello', max_output_tokens: -1 }, 'responses', 'codex-cli')).rejects.toMatchObject({ code: 'output_limit' });
    f.store.saveModel({ ...f.store.model(f.model.id)!, maxOutputTokens: 10000 });
    await expect(f.gateway.execute(f.apiKey, { model: f.model.id, input: 'hello', max_output_tokens: 20000 }, 'responses', 'codex-cli')).rejects.toMatchObject({ code: 'output_limit' });
    expect(sent).toHaveLength(2);
  });
  test('capacity filtering only compares known limits and the catalog preserves unknown image support', async () => {
    const f = await setup(async () => Response.json(completion()));
    const unknown = { ...f.model, contextWindow: undefined, maxOutputTokens: undefined, routes: f.model.routes.map(route => ({ ...route, contextWindow: undefined, vision: undefined })) };
    f.store.saveModel(unknown);
    const catalog = JSON.parse(JSON.stringify(f.gateway.catalog(f.employee, 'codex-cli')))[0];
    expect(catalog).not.toHaveProperty('contextWindow'); expect(catalog).not.toHaveProperty('maxOutputTokens'); expect(catalog).not.toHaveProperty('vision');
    expect(f.gateway.channels(unknown, 'responses')).toHaveLength(3);
    expect(f.gateway.channels({ ...unknown, contextWindow: 128000 }, 'responses')).toHaveLength(3);
    const limitedRoutes = unknown.routes.map(route => ({ ...route, contextWindow: 1024 }));
    expect(f.gateway.channels({ ...unknown, routes: limitedRoutes }, 'responses')).toHaveLength(3);
    expect(f.gateway.channels({ ...unknown, contextWindow: 128000, routes: limitedRoutes }, 'responses')).toHaveLength(0);
    f.store.saveModel({ ...unknown, routes: unknown.routes.map(route => ({ ...route, vision: false })) });
    expect(f.gateway.catalog(f.employee, 'codex-cli')[0].vision).toBe(false);
    f.store.saveModel({ ...unknown, routes: unknown.routes.map((route, index) => ({ ...route, vision: index === 0 ? true : undefined })) });
    expect(f.gateway.catalog(f.employee, 'codex-cli')[0].vision).toBe(true);
  });
  test('image requests reach unknown-capability providers but exclude explicitly text-only routes', async () => {
    const calls: string[] = [];
    const f = await setup(async (_, init) => { calls.push(new Headers(init?.headers).get('authorization')!); return Response.json(completion()); });
    f.store.saveModel({ ...f.model, routes: f.model.routes.map((route, index) => ({ ...route, vision: index === 0 ? false : undefined })) });
    const request = { model: f.model.id, input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://image.test/example.png' }] }] };
    await f.gateway.execute(f.apiKey, request, 'responses', 'codex-cli');
    expect(calls).toEqual(['Bearer vendor-secret-v1']);
    f.store.saveModel(f.model);
    await expect(f.gateway.execute(f.apiKey, request, 'responses', 'codex-cli')).rejects.toMatchObject({ code: 'no_compatible_channel' });
    expect(calls).toHaveLength(1);
  });
  test('retries an explicit 429, shares cooldown, preserves request attribution and hides real keys', async () => {
    const seen: string[] = [];
    const f = await setup(async (_, init) => {
      const key = (init!.headers as Record<string, string>).authorization; seen.push(key);
      return key.includes('z1') ? Response.json({ error: { code: 'rate_limit', message: `busy ${key}` } }, { status: 429, headers: { 'retry-after': '60' } }) : Response.json(completion());
    });
    const one = await f.gateway.execute(f.apiKey, { model: 'glm-test', input: 'hi' }, 'responses', 'codex-cli');
    expect(one.json?.output[0].content[0].text).toBe('完成');
    expect(f.store.attempts(one.requestId)).toHaveLength(2);
    expect(f.store.blocked(f.keys[0], 'glm-test')).toBeTruthy();
    await f.gateway.execute(f.apiKey, { model: 'glm-test', input: 'again' }, 'responses', 'codex-cli');
    expect(seen.filter(k => k.includes('z1'))).toHaveLength(1);
    expect(JSON.stringify(f.store.attempts(one.requestId))).not.toContain('vendor-secret');
    expect(f.store.stats().requests).toBe(2);
  });
  test('revocation prevents future requests without contacting any vendor', async () => {
    let called = 0;
    const f = await setup(async () => { called++; return Response.json(completion()); });
    f.store.revoke(f.employee.id);
    await expect(f.gateway.execute(f.apiKey, { model: 'glm-test', input: 'hi' }, 'responses', 'codex-cli')).rejects.toMatchObject({ status: 401 });
    expect(called).toBe(0);
  });
  test('all compatible keys are attempted before exposing 429; no other model is used', async () => {
    const calls: string[] = [];
    const f = await setup(async (_, init) => { calls.push((init!.headers as Record<string, string>).authorization); return Response.json({ error: { code: 'rate_limit', message: 'try later' } }, { status: 429 }); });
    await expect(f.gateway.execute(f.apiKey, { model: 'glm-test', input: 'hi' }, 'responses', 'codex-cli')).rejects.toMatchObject({ status: 429 });
    expect(new Set(calls).size).toBe(3);
  });
  test('after text starts, a broken upstream stream is reported without another attempt', async () => {
    let calls = 0;
    const f = await setup(async () => { calls++; return chatSSE(textChunks().slice(0, 2), false); });
    const result = await f.gateway.execute(f.apiKey, { model: 'glm-test', input: 'hi', stream: true }, 'responses', 'codex-cli');
    let text = ''; for await (const chunk of result.stream!) text += chunk;
    expect(text).toContain('response.output_text.delta'); expect(text).toContain('incomplete_stream');
    expect(text).not.toContain('response.completed'); expect(calls).toBe(1);
    expect(f.store.requests()[0].status).toBe('error');
  });
  test('streaming usage is captured once, including usage-only upstream chunks', async () => {
    const f = await setup(async () => chatSSE(textChunks()));
    const result = await f.gateway.execute(f.apiKey, { model: 'glm-test', input: 'hi', stream: true }, 'messages', 'claude-code');
    let text = ''; for await (const chunk of result.stream!) text += chunk;
    expect(text).toContain('message_stop');
    const [attempt] = f.store.attempts(result.requestId);
    expect(attempt.input_tokens).toBe(12); expect(attempt.output_tokens).toBe(2);
    expect(f.store.stats().requests).toBe(1);
  });
  test('native HTTP transport works through the Fastify inference route', async () => {
    const f = await fixture(); stores.push(f.store);
    const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'http://localhost', gateway: { fetch: async () => chatSSE(textChunks()) } });
    const response = await app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${f.apiKey}` }, payload: { model: 'glm-test', input: 'hi', stream: true } });
    expect(response.statusCode).toBe(200); expect(response.body).toContain('response.completed'); expect(response.headers['x-request-id']).toBeTruthy();
    await app.close();
  });
});

test('an open streaming response occupies capacity until consumed and cancellation releases it', async () => {
  const f = await setup(async () => chatSSE(textChunks()));
  const result = await f.gateway.execute(f.apiKey, { model: 'glm-test', input: 'hi', stream: true }, 'responses', 'codex-cli');
  expect(f.gateway.pool.live().active).toBe(1);
  for await (const _ of result.stream!) { /* finish the stream */ }
  expect(f.gateway.pool.live().active).toBe(0);
  const next = await f.gateway.execute(f.apiKey, { model: 'glm-test', input: 'hi', stream: true }, 'responses', 'codex-cli');
  expect(f.gateway.pool.live().active).toBe(1);
  for await (const _ of next.stream!) break;
  expect(f.gateway.pool.live().active).toBe(0);
});


test('InvalidSubscription retries another account, stays cooled across requests and can recover', async () => {
  const seen: string[] = [];
  let repaired = false;
  const f = await setup(async (_, init) => {
    const key = new Headers(init?.headers).get('authorization')!; seen.push(key);
    return key.includes('z1') && !repaired
      ? Response.json({ error: { code: 'InvalidSubscription', message: '缺少有效订阅或未分配席位' } }, { status: 400 })
      : Response.json(completion());
  });
  const first = await f.gateway.execute(f.apiKey, { model: 'glm-test', input: 'hi' }, 'responses', 'codex-cli');
  expect(first.json?.output[0].content[0].text).toBe('完成');
  expect(f.store.attempts(first.requestId)).toHaveLength(2);
  expect(f.store.blocked(f.keys[0], 'another-model')?.reason).toBe('InvalidSubscription');
  expect(f.store.blocked(f.keys[1], 'glm-test')).toBeUndefined();
  await f.gateway.execute(f.apiKey, { model: 'glm-test', input: 'again' }, 'responses', 'codex-cli');
  expect(seen.filter(k => k.includes('z1'))).toHaveLength(1);
  repaired = true; f.store.resetKey(f.keys[0]);
  f.store.saveModel({ ...f.model, routes: f.model.routes.filter(r => r.providerId === 'zhipu') });
  f.store.saveKey({ ...f.keys[1], enabled: false });
  await f.gateway.execute(f.apiKey, { model: 'glm-test', input: 'recovered' }, 'responses', 'codex-cli');
  expect(seen.at(-1)).toContain('z1');
  expect(f.store.blocked(f.keys[0], 'glm-test')).toBeUndefined();
});

test('subscription cooldown shares only an explicit account group and honors retry-after', async () => {
  const f = await setup(async () => Response.json(completion()));
  const key = { ...f.keys[0], rateScope: 'group' as const, group: 'account-a' };
  const failure = classifyUpstream(400, { error: { type: 'InvalidSubscription' } }, key, 'glm-test', '600');
  expect(failure).toMatchObject({ status: 503, retryable: true, scope: 'group:zhipu:account-a', cooldown: 600000, progressive: false });
  f.store.block(failure.scope!, Date.now() + failure.cooldown!, failure.code);
  expect(f.store.blocked({ ...f.keys[1], rateScope: 'group', group: 'account-a' }, 'another-model')).toBeTruthy();
  expect(f.store.blocked({ ...f.keys[1], rateScope: 'group', group: 'account-b' }, 'glm-test')).toBeUndefined();
});

test('all subscription failures return a service error after bounded attempts', async () => {
  let calls = 0;
  const f = await setup(async () => { calls++; return Response.json({ error: { code: 'InvalidSubscription', message: '订阅已过期' } }, { status: 400 }); });
  await expect(f.gateway.execute(f.apiKey, { model: 'glm-test', input: 'hi' }, 'responses', 'codex-cli')).rejects.toMatchObject({ status: 503, code: 'InvalidSubscription' });
  expect(calls).toBe(3);
  await expect(f.gateway.execute(f.apiKey, { model: 'glm-test', input: 'again' }, 'responses', 'codex-cli')).rejects.toMatchObject({ status: 503 });
  expect(calls).toBe(3);
});

test('ordinary HTTP 400 is not retried or cooled even when message mentions subscriptions', async () => {
  let calls = 0;
  const f = await setup(async () => { calls++; return Response.json({ error: { code: 'invalid_request', message: 'InvalidSubscription is not a valid parameter' } }, { status: 400 }); });
  await expect(f.gateway.execute(f.apiKey, { model: 'glm-test', input: 'hi' }, 'responses', 'codex-cli')).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
  expect(calls).toBe(1);
  expect(f.keys.every(k => !f.store.blocked(k, 'glm-test'))).toBe(true);
});
