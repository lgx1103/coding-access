import { describe, expect, test } from 'vitest';
import { AdaptivePool, FairQueue, type Candidate } from '../src/server/scheduler.js';

const candidates: Candidate[] = [
  { id: 'z1', providerId: 'zhipu', providerWeight: 2, keyWeight: 1, maxConcurrent: 10 },
  { id: 'v1', providerId: 'volcano', providerWeight: 1, keyWeight: 1, maxConcurrent: 10 },
];
describe('proactive model resource pool', () => {
  test('healthy providers both receive work, with the configured preference', () => {
    const pool = new AdaptivePool(60_000, () => 0);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 300; i++) {
      const lease = pool.acquire(candidates)!;
      counts[lease.candidate.providerId] = (counts[lease.candidate.providerId] ?? 0) + 1;
      lease.release(1);
    }
    expect(counts.zhipu).toBe(200); expect(counts.volcano).toBe(100);
  });
  test('redirects to idle Volcano while Zhipu is busy, without any 429', () => {
    const pool = new AdaptivePool(60_000, () => 0);
    const large = pool.acquire(candidates, 100)!;
    expect(large.candidate.providerId).toBe('zhipu');
    const next = pool.acquire(candidates, 1)!;
    expect(next.candidate.providerId).toBe('volcano');
    large.release(); next.release();
  });
  test('actual consumption changes subsequent allocation, and decays over time', () => {
    let time = 0;
    const pool = new AdaptivePool(1000, () => time);
    const first = pool.acquire(candidates)!; first.release(1000);
    expect(pool.acquire(candidates)!.candidate.providerId).toBe('volcano');
    time = 30_000;
    expect(pool.acquire(candidates)!.candidate.providerId).toBe('zhipu');
  });
  test('reserves capacity atomically and release is idempotent', () => {
    const pool = new AdaptivePool();
    const one = [{ ...candidates[0], maxConcurrent: 1 }];
    const lease = pool.acquire(one)!;
    expect(pool.acquire(one)).toBeNull();
    lease.release(); lease.release();
    expect(pool.active('z1')).toBe(0);
    expect(pool.acquire(one)).not.toBeNull();
  });
  test('keys sharing an upstream capacity group share reservations', () => {
    const pool = new AdaptivePool();
    const keys = [1, 2].map(n => ({ ...candidates[0], id: `z${n}`, group: 'same-account', maxConcurrent: 1 }));
    const lease = pool.acquire(keys)!;
    expect(pool.acquire(keys)).toBeNull();
    lease.release(); expect(pool.acquire(keys)).not.toBeNull();
  });
});

describe('employee admission', () => {
  test('one employee cannot occupy every slot while others are waiting', async () => {
    const queue = new FairQueue(2, 1); const signal = new AbortController().signal;
    const first = await queue.enter('alice', signal);
    let secondAliceStarted = false;
    const second = queue.enter('alice', signal).then(release => { secondAliceStarted = true; return release; });
    const bob = await queue.enter('bob', signal);
    expect(secondAliceStarted).toBe(false);
    bob(); first(); (await second)(); expect(queue.queued).toBe(0);
  });
  test('cancelled queued requests never dispatch', async () => {
    const queue = new FairQueue(1, 1);
    const release = await queue.enter('alice', new AbortController().signal);
    const abort = new AbortController();
    const pending = queue.enter('bob', abort.signal);
    abort.abort(); await expect(pending).rejects.toThrow('取消');
    release(); expect(queue.queued).toBe(0);
  });
});
