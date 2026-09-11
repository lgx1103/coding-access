import { afterEach, expect, test } from 'vitest';
import { ApiError, classifyUpstream, errorBody, streamError, upstreamApiError } from '../src/server/errors.js';
import { createApp } from '../src/server/app.js';
import { Gateway } from '../src/server/gateway.js';
import { chatSSE, textChunks, fixture } from './helpers.js';
import type { Store } from '../src/server/db.js';

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach(s => s.close()));

test.each([
  [400, 'InvalidSubscription', 'subscription', true, 503],
  [429, '1309', 'subscription', true, 503],
  [429, '1314', 'subscription', true, 503],
  [429, '1113', 'quota', true, 429],
  [429, '1310', 'quota', true, 429],
  [429, 'insufficient_quota', 'quota', true, 429],
  [402, 'balance', 'quota', true, 429],
  [429, '1311', 'configuration', true, 503],
  [401, 'authentication_error', 'authentication', true, 503],
  [429, '1305', 'service', true, 503],
  [529, 'overloaded_error', 'service', true, 529],
  [429, 'rate_limit_error', 'rate_limit', true, 429],
  [400, '1301', 'content_policy', false, 400],
  [400, '1261', 'context_length', false, 400],
  [413, 'request_too_large', 'context_length', false, 413],
  [422, 'invalid_parameters', 'invalid_request', false, 422],
] as const)('classifies %s/%s without exposing vendor diagnostics', async (status, code, category, retryable, expectedStatus) => {
  const f = await fixture(); stores.push(f.store);
  const failure = classifyUpstream(status, { error: { code, message: 'private-account-id vendor-console-url' } }, f.keys[0], f.model.id);
  expect(failure).toMatchObject({ category, retryable, status: expectedStatus });
  const error = upstreamApiError(failure);
  expect(error.message).toContain('private-account-id');
  for (const protocol of ['messages', 'responses', 'chat'] as const) {
    expect(JSON.stringify(errorBody(error, 'req-example', protocol))).not.toContain('private-account-id');
    expect(streamError(error, protocol, 'req-example')).not.toContain('vendor-console-url');
    expect(streamError(error, protocol, 'req-example')).toContain(`upstream_${category}`);
  }
});

test('HTTP callers get friendly errors and request ids; administrators retain original attempt details', async () => {
  const f = await fixture(); stores.push(f.store);
  const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'http://localhost', gateway: { fetch: async () => Response.json({ error: { code: 'InvalidSubscription', message: 'private-account-id' } }, { status: 400 }) } });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${f.apiKey}` }, payload: { model: f.model.id, input: 'hi' } });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.error.code).toBe('upstream_subscription');
    expect(body.request_id).toBeTruthy();
    expect(response.body).not.toContain('private-account-id');
    expect(JSON.stringify(f.store.requests())).not.toContain('private-account-id');
    expect(f.store.attempts(body.request_id).some(a => a.code === 'InvalidSubscription' && a.message === 'private-account-id')).toBe(true);
  } finally { await app.close(); }
});

test('company authentication and server failures keep their own error identity', () => {
  expect(errorBody(new ApiError(401, 'invalid_api_key', '请重新登录')).error.code).toBe('invalid_api_key');
  expect(errorBody(new ApiError(500, 'server_error', '服务异常')).error.code).toBe('server_error');
});

test('resource API keeps expired cooldown pending until a successful request confirms recovery', async () => {
  const f = await fixture(); stores.push(f.store);
  const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'http://localhost' });
  try {
    f.store.success(f.keys[0], f.model.id);
    f.store.block('key-model:z1:glm-test', Date.now() + 60000, '1311');
    const getKey = async () => (await app.inject({ method: 'GET', url: '/api/admin/keys', headers: { authorization: `Bearer ${f.adminSession}` } })).json().keys.find((k: any) => k.id === 'z1');
    expect((await getKey()).states[0].state.reason).toBe('1311');
    f.store.db.prepare('UPDATE states SET until_ms=?').run(Date.now() - 1);
    const pending = await getKey();
    expect(pending.lastSuccess).toBeTruthy();
    expect(pending.states[0].state).toBeUndefined();
    expect(pending.states[0].recoveryPending).toBe(true);
    f.store.success(f.keys[0], f.model.id);
    expect((await getKey()).states[0].recoveryPending).toBe(false);
  } finally { await app.close(); }
});


test('an error after streamed text is sanitized without replaying the request', async () => {
  const f = await fixture(); stores.push(f.store); let calls = 0;
  const gateway = new Gateway(f.store, f.box, { fetch: async () => {
    calls++;
    return chatSSE([textChunks()[0], { error: { code: 'private_vendor_code', message: 'private-account-id' } }], false);
  } });
  const result = await gateway.execute(f.apiKey, { model: f.model.id, input: 'hi', stream: true }, 'responses', 'codex-cli');
  let output = ''; for await (const part of result.stream!) output += part;
  expect(output).toContain('response.output_text.delta');
  expect(output).toContain('upstream_service');
  expect(output).not.toContain('private-account-id');
  expect(output).not.toContain('private_vendor_code');
  expect(calls).toBe(1);
  expect(f.store.attempts(result.requestId)[0].message).toBe('private-account-id');
});
