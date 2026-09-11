import { expect, test } from 'vitest';
import { fixture } from './helpers.js';
import { analytics, analyticsQuery, analyticsExport } from '../src/server/analytics.js';
import { classifyUpstream, quotaResetDelay } from '../src/server/errors.js';
import { readUsage } from '../src/server/protocols.js';
import { AdaptivePool } from '../src/server/scheduler.js';

test('full-range aggregates preserve retries, missing usage, dates, identity and self-only scope', async () => {
  const f = await fixture();
  const from = Date.parse('2026-09-01T00:00:00+08:00');
  const add = (user: string, at: number, status: string, attempts: Array<[number | null, number | null, string]>) => {
    const id = f.store.beginRequest(user, f.model.id, 'claude-code');
    f.store.db.prepare('UPDATE requests SET started_at=?,status=? WHERE id=?').run(at, status, id);
    attempts.forEach(([input, output, state], i) => f.store.attempt({ id: `${id}-${i}`, requestId: id, providerId: 'zhipu', keyId: 'z1', startedAt: at + i, status: state, input, output, cached: input == null ? null : 3 }));
    return id;
  };
  add('employee', from - 1, 'success', [[999, 999, 'success']]);
  add('employee', from, 'success', [[null, null, 'error'], [10, 5, 'success']]);
  add('employee', from + 1, 'error', []);
  add('admin', from + 86400_000, 'success', [[null, null, 'success']]);
  add('employee', from + 2 * 86400_000, 'running', [[null, null, 'running']]);
  add('employee', from + 3 * 86400_000, 'success', [[900, 900, 'success']]);
  const q = analyticsQuery.parse({ from, to: from + 3 * 86400_000, limit: 1 });
  const a = analytics(f.store, q);
  expect(a.totals).toMatchObject({ requests: 4, success: 2, retries: 1, first_success: 1, total_tokens: 15, cached_tokens: 3, missing_success: 1, missing_failed: 1, pending_usage: 1 });
  expect(a.details).toHaveLength(1); expect(a.details[0]).not.toHaveProperty('credential_id');
  expect(analytics(f.store, { ...q, grain: 'month' }).trend.map(r => r.day)).toEqual(['2026-09-01']);
  expect(analytics(f.store, { ...q, userIds: ['employee'], modelIds: [f.model.id], status: 'success' }).totals.requests).toBe(1);
  expect(analytics(f.store, { ...q, providerId: 'absent' }).totals.requests).toBe(0); expect(a.models[0].total_tokens).toBe(15);
  expect(a.trend.map(d => d.day)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
  expect(analytics(f.store, { ...q, grain: 'week' }).trend[0].day).toBe('2026-08-31');
  expect(analytics(f.store, { ...q, userIds: ['admin'] }, 'employee').totals.requests).toBe(3);
  expect(analytics(f.store, { ...q, modelIds: ['absent'] }).totals.total_tokens).toBeNull();
  f.store.db.prepare('DELETE FROM models WHERE id=?').run(f.model.id);
  expect(analytics(f.store, q).models[0].name).toBe('GLM Test');
  f.store.close();
});

test('cache fields are normalized by upstream protocol and streamed deltas do not double count', () => {
  const first = readUsage({ usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 } }, undefined, 'messages');
  expect(first).toEqual({ input: 110, output: 1, cached: 80 });
  expect(readUsage({ usage: { output_tokens: 7 } }, first, 'messages')).toEqual({ input: 110, output: 7, cached: 80 });
  expect(readUsage({ usage: { prompt_tokens: 110, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 80 } } }, undefined, 'chat')).toEqual({ input: 110, output: 7, cached: 80 });
});

test('quota recovery is Beijing time and applies across models without blocking independent accounts', async () => {
  const f = await fixture(); const now = Date.parse('2026-09-07T12:00:00Z');
  expect(quotaResetDelay('额度将于 2026-09-07 20:16:15 重置', now)).toBe(975000);
  expect(quotaResetDelay('重置时间未知', now)).toBeUndefined();
  const failure = classifyUpstream(429, { error: { code: '1308', message: '额度耗尽' } }, { ...f.keys[0], rateScope: 'model' }, f.model.id);
  expect(failure).toMatchObject({ cooldown: 300000, progressive: true, scope: 'key:z1' });
  f.store.block(failure.scope!, Date.now() + failure.cooldown!, failure.code);
  expect(f.store.blocked({ ...f.keys[0], rateScope: 'model' }, 'another-model')).toBeTruthy();
  expect(f.store.blocked(f.keys[1], f.model.id)).toBeUndefined();
  expect(classifyUpstream(429, { error: { code: '1308' } }, f.keys[0], f.model.id, '1800').cooldown).toBe(1800000);
  f.store.close();
});

test('live concurrency returns to zero and five-minute peak expires', () => {
  let now = 1000000; const pool = new AdaptivePool(60000, () => now);
  const c = [{ id: 'k', providerId: 'p', providerWeight: 1, keyWeight: 1, maxConcurrent: 2 }];
  const a = pool.acquire(c)!; const b = pool.acquire(c)!;
  expect(pool.live()).toMatchObject({ active: 2, peak: 2 }); expect(pool.acquire(c)).toBeNull();
  a.release(); a.release(); b.release(); expect(pool.live()).toMatchObject({ active: 0, peak: 2 });
  now += 301000; expect(pool.live()).toMatchObject({ active: 0, peak: 0 });
});


test('large exports include every filtered request and yield to other work between batches', async () => {
  const f = await fixture(); const from = Date.now() - 1000;
  for (let i = 0; i < 600; i++) {
    const id = f.store.beginRequest('employee', f.model.id, 'claude-code');
    f.store.attempt({ id: `bulk-${i}`, requestId: id, providerId: 'zhipu', keyId: 'z1', startedAt: Date.now(), status: 'success', input: 10, output: 2, cached: 0 });
    f.store.finishRequest(id, 'success');
  }
  let serviced = false; setImmediate(() => { serviced = true; });
  const lines: string[] = [];
  for await (const line of analyticsExport(f.store, analyticsQuery.parse({ from, to: Date.now() + 1000, limit: 1 }))) lines.push(line);
  expect(lines).toHaveLength(601); expect(serviced).toBe(true);
  expect(lines.slice(1).every(l => l.includes(',"10","2",'))).toBe(true);
  f.store.close();
});
