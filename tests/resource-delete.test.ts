import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.js';
import { fixture } from './helpers.js';

test('explicit deletion supports enabled idle keys but protects active requests and provider references', async () => {
  const f = await fixture();
  const { app, gateway } = await createApp({ store: f.store, box: f.box, publicUrl: 'http://localhost' });
  const headers = { authorization: `Bearer ${f.adminSession}` };
  try {
    const lease = gateway.pool.acquire([{ id: 'z1', providerId: 'zhipu', keyWeight: 1, providerWeight: 1, maxConcurrent: 2 }])!;
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/keys/z1', headers })).statusCode).toBe(409);
    lease.release();
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/keys/z1', headers })).statusCode).toBe(200);
    expect(f.store.key('z1')).toBeUndefined();
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/providers/zhipu', headers })).statusCode).toBe(409);
    f.store.saveProvider({ ...f.providers[0], id: 'empty-provider' });
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/providers/empty-provider', headers })).statusCode).toBe(200);
    expect(f.store.provider('empty-provider')).toBeUndefined();
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/keys/z2' })).statusCode).toBe(401);
  } finally { await app.close(); f.store.close(); }
});
