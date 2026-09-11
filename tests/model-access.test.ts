import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/db.js';
import { canUseModel, publicationLabel } from '../src/shared/model-access.js';
import { fixture, completion } from './helpers.js';
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup(capacity = 16) {
  const f = await fixture(); cleanup.push(() => f.store.close());
  let fetches = 0;
  const { app, gateway } = await createApp({ store: f.store, box: f.box, publicUrl: 'https://company.test', gateway: { capacity, fetch: async () => { fetches++; return Response.json(completion()); } } }); cleanup.push(() => app.close());
  const headers = { authorization: `Bearer ${f.adminSession}` };
  const session = f.store.issue(f.employee.id, 'session', 'desktop').token;
  return { ...f, app, gateway, headers, fetches: () => fetches,
    catalog: async () => (await app.inject({ url: '/api/models?agent=claude-code', headers: { authorization: `Bearer ${session}` } })).json().models,
    update: (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: `/api/admin/models/${f.model.id}`, headers, payload }),
    invoke: () => app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${f.apiKey}` }, payload: { model: f.model.id, input: 'hello' } }),
  };
}
test('new publication defaults to all current and future members; draft stays invisible', async () => {
  const f = await setup();
  const payload = { name: 'New Team Model', agents: ['claude-code'], routes: [f.model.routes[0]] };
  const create = await f.app.inject({ method: 'POST', url: '/api/admin/models', headers: f.headers, payload });
  expect(create.statusCode).toBe(201); const draft = create.json().model;
  expect(draft).toMatchObject({ enabled: false, audience: { type: 'all' }, everPublished: false });
  expect((await f.catalog()).map((m: any) => m.id)).toEqual([f.model.id]);
  expect(f.store.publicUser(f.employee).models).toEqual([f.model.id]);
  const publish = await f.app.inject({ method: 'PUT', url: `/api/admin/models/${draft.id}`, headers: f.headers, payload: { ...draft, enabled: true } });
  expect(publish.statusCode).toBe(200);
  const member = await f.app.inject({ method: 'POST', url: '/api/admin/users', headers: f.headers, payload: { username: 'future', name: '新成员', password: 'Password123' } });
  expect(member.statusCode).toBe(200); expect(member.json().user.models).toEqual([draft.id]);
  expect(f.store.publicUser(f.employee).models).toEqual([f.model.id, draft.id]);
  expect((await f.catalog()).map((m: any) => m.id)).toContain(draft.id);
  expect(f.store.authenticate(f.apiKey, 'api')).toBeTruthy();
});
test('selected scope and publication change atomically; unpublished models are never usable', async () => {
  const f = await setup(); const other = { ...f.employee, id: 'other', username: 'other', models: [] }; f.store.saveUser(other);
  const original = f.store.model(f.model.id);
  for (const userIds of [[], ['missing'], [f.employee.id, f.employee.id]]) {
    const result = await f.update({ ...f.model, audience: { type: 'selected', userIds } });
    expect(result.statusCode).toBe(400); expect(f.store.model(f.model.id)).toEqual(original); expect(f.store.versions()).toHaveLength(0);
  }
  expect((await f.update({ ...f.model, audience: { type: 'selected', userIds: ['other'] } })).statusCode).toBe(200);
  expect(await f.catalog()).toEqual([]); expect((await f.invoke()).statusCode).toBe(403); expect(f.fetches()).toBe(0);
  expect(canUseModel(other, f.store.model(f.model.id)!)).toBe(true); expect(canUseModel(f.admin, f.store.model(f.model.id)!)).toBe(true);
  expect((await f.update({ ...f.model, enabled: false, audience: { type: 'selected', userIds: ['other'] } })).statusCode).toBe(200);
  const withdrawn = f.store.model(f.model.id)!; expect(publicationLabel(withdrawn)).toBe('已下架'); expect(canUseModel(f.admin, withdrawn)).toBe(false);
  expect(f.store.publicUser(other).models).toEqual([]); expect((await f.invoke()).statusCode).toBe(403);
  expect((await f.update({ ...withdrawn, enabled: true })).statusCode).toBe(200);
  expect(f.store.model(f.model.id)?.audience).toEqual({ type: 'selected', userIds: ['other'] });
  expect(canUseModel({ ...other, enabled: false }, f.store.model(f.model.id)!)).toBe(false);
});
test('empty selected drafts can be saved but cannot be published, and legacy user permission fields are rejected', async () => {
  const f = await setup();
  expect((await f.update({ ...f.model, enabled: false, audience: { type: 'selected', userIds: [] } })).statusCode).toBe(200);
  expect((await f.update({ ...f.store.model(f.model.id), enabled: true })).statusCode).toBe(400);
  const result = await f.app.inject({ method: 'PUT', url: `/api/admin/users/${f.employee.id}`, headers: f.headers, payload: { name: 'changed', role: 'employee', enabled: true, models: [f.model.id] } });
  expect(result.statusCode).toBe(409); expect(f.store.user(f.employee.id)?.name).toBe(f.employee.name);
  expect(f.store.publicUser(f.employee).models).toEqual([]);
  expect((await f.app.inject({ method: 'POST', url: '/api/admin/users', headers: f.headers, payload: { name: 'stale', username: 'stale', password: 'Password123', models: [] } })).statusCode).toBe(409);
});
test('legacy grants migrate exactly, including unpublished pregrants, and remain frozen after restart', async () => {
  const f = await fixture(); cleanup.push(() => f.store.close());
  const dir = mkdtempSync(join(tmpdir(), 'aca-audience-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'legacy.sqlite');
  const { audience: _, everPublished: __, ...legacy } = f.model;
  f.store.db.prepare('UPDATE models SET data=? WHERE id=?').run(JSON.stringify(legacy), legacy.id);
  f.store.db.prepare('INSERT INTO models VALUES(?,?)').run('draft', JSON.stringify({ ...legacy, id: 'draft', enabled: false }));
  f.store.saveUser({ ...f.employee, models: [legacy.id, 'draft'] });
  f.store.saveUser({ ...f.employee, id: 'excluded', username: 'excluded', models: [] });
  f.store.db.prepare('VACUUM INTO ?').run(path);
  let store = new Store(path);
  try {
    for (const model of store.models()) expect(model.audience).toEqual({ type: 'selected', userIds: [f.employee.id] });
    expect(store.publicUser(store.user(f.employee.id)!).models).toEqual([legacy.id]);
    expect(store.publicUser(store.user('excluded')!).models).toEqual([]);
    store.saveUser({ ...f.employee, id: 'future', username: 'future', models: [legacy.id, 'draft'] });
    expect(store.publicUser(store.user('future')!).models).toEqual([]);
    store.close(); store = new Store(path);
    expect(store.model(legacy.id)?.audience).toEqual({ type: 'selected', userIds: [f.employee.id] });
    expect(store.publicUser(store.user('future')!).models).toEqual([]);
    expect(store.authenticate(f.apiKey, 'api')).toBeTruthy();
  } finally { store.close(); }
});
test('configuration restore preserves current audience and cannot resurrect deleted model grants', async () => {
  const f = await setup(); const version = f.store.saveVersion(f.admin.id, 'original');
  f.store.saveModel({ ...f.model, audience: { type: 'selected', userIds: [] } });
  f.store.restoreVersion(version);
  expect((await f.invoke()).statusCode).toBe(403);
  f.store.db.prepare('DELETE FROM models WHERE id=?').run(f.model.id);
  f.store.restoreVersion(version);
  expect(f.store.model(f.model.id)?.audience).toEqual({ type: 'selected', userIds: [] });
  expect((await f.invoke()).statusCode).toBe(403);
});
test.each(['audience', 'unpublish', 'delete', 'user', 'agent'] as const)('queued request rechecks %s before contacting any provider', async change => {
  const f = await setup(1);
  const release = await f.gateway.queue.enter(f.employee.id, new AbortController().signal);
  const pending = f.gateway.execute(f.apiKey, { model: f.model.id, input: 'hello' }, 'responses', 'codex-cli');
  const rejected = expect(pending).rejects.toMatchObject({ code: change === 'agent' ? 'agent_not_enabled' : 'access_revoked' });
  expect(f.gateway.queue.queued).toBe(1);
  if (change === 'audience') f.store.saveModel({ ...f.model, audience: { type: 'selected', userIds: [] } });
  if (change === 'unpublish') f.store.saveModel({ ...f.model, enabled: false });
  if (change === 'delete') f.store.db.prepare('DELETE FROM models WHERE id=?').run(f.model.id);
  if (change === 'user') f.store.saveUser({ ...f.employee, enabled: false });
  if (change === 'agent') f.store.saveModel({ ...f.model, agents: ['claude-code'] });
  release(); await rejected;
  expect(f.fetches()).toBe(0); expect(f.gateway.queue.queued).toBe(0);
});
