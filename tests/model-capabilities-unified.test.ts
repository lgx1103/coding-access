import { expect, test } from 'vitest';
import { Store } from '../src/server/db.js';
import { createApp } from '../src/server/app.js';
import { fixture, completion } from './helpers.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('startup migration freezes capabilities, backs up raw data, preserves explicit limits and permissions', async () => {
  const f = await fixture(); const dir = mkdtempSync(join(tmpdir(), 'aca-capabilities-')); const path = join(dir, 'db.sqlite');
  const variants = [
    { ...f.model, id: 'explicit', contextWindow: 1000000, maxOutputTokens: 32000, routes: [{ ...f.model.routes[0], contextWindow: 256000, vision: true }, { ...f.model.routes[1], contextWindow: 1000000, vision: false }] },
    { ...f.model, id: 'minimum', contextWindow: undefined, routes: [{ ...f.model.routes[0], contextWindow: 256000, vision: true }, { ...f.model.routes[1], contextWindow: 1000000, vision: true }] },
    { ...f.model, id: 'unknown', contextWindow: undefined, routes: [{ ...f.model.routes[0], contextWindow: 256000, vision: true }, { ...f.model.routes[1], contextWindow: undefined, vision: undefined }] },
    { ...f.model, id: 'already-unified', capabilityMode: 'unified' as const, contextWindow: undefined, vision: undefined },
  ];
  for (const m of variants) f.store.saveModel(m);
  f.store.db.prepare('VACUUM INTO ?').run(path);
  let store = new Store(path);
  try {
    const explicit = store.model('explicit')!;
    expect(explicit).toMatchObject({ capabilityMode: 'unified', contextWindow: 1000000, maxOutputTokens: 32000, vision: false, audience: f.model.audience, enabled: true, routes: variants[0].routes });
    expect(store.model('minimum')).toMatchObject({ contextWindow: 256000, vision: true });
    expect(store.model('unknown')!.contextWindow).toBeUndefined();
    expect(store.model('unknown')!.vision).toBeUndefined();
    expect(store.model('already-unified')!.contextWindow).toBeUndefined();
    const versions = store.versions(); expect(versions).toHaveLength(1);
    const snapshot = JSON.parse(String(store.db.prepare('SELECT snapshot FROM config_versions').get()!.snapshot));
    expect(snapshot.models.find((m: any) => m.id === 'explicit').capabilityMode).toBeUndefined();
    store.close(); store = new Store(path);
    expect(store.versions()).toHaveLength(1);
    expect(store.model('explicit')).toEqual(explicit);
  } finally { store.close(); f.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('unified model API propagates capacity and image support to existing clients and keeps optional output unset', async () => {
  const f = await fixture(); const sent: any[] = [];
  const { app, gateway } = await createApp({ ...f, publicUrl: 'http://localhost', gateway: { fetch: async (_, init) => { sent.push(JSON.parse(String(init?.body))); return Response.json(completion()); } } });
  const headers = { authorization: `Bearer ${f.adminSession}` };
  try {
    const payload = { name: 'Unified Model', enabled: true, audience: { type: 'all' }, agents: ['codex-cli'], capabilityMode: 'unified', contextWindow: 1000000, vision: true, routes: [{ providerId: 'zhipu', upstreamModel: 'Vendor-Exact-ID', weight: 1 }] };
    const response = await app.inject({ method: 'POST', url: '/api/admin/models', headers, payload });
    expect(response.statusCode).toBe(201);
    const model = response.json().model;
    expect(model.routes[0].upstreamModel).toBe('Vendor-Exact-ID');
    expect(gateway.catalog(f.employee, 'codex-cli').find(m => m.id === model.id)).toMatchObject({ contextWindow: 1000000, vision: true });
    expect(gateway.channels(f.store.model(model.id)!, 'responses', true)).toHaveLength(2);
    await gateway.execute(f.apiKey, { model: model.id, input: 'hi' }, 'responses', 'codex-cli');
    expect(sent[0]).not.toHaveProperty('max_tokens');
    expect(sent[0].model).toBe('Vendor-Exact-ID');
    const { contextWindow: _, vision: __, ...blank } = model;
    expect((await app.inject({ method: 'PUT', url: `/api/admin/models/${model.id}`, headers, payload: blank })).statusCode).toBe(200);
    const catalog = gateway.catalog(f.employee, 'codex-cli').find(m => m.id === model.id)!;
    expect(catalog.contextWindow).toBeUndefined(); expect(catalog.vision).toBeUndefined(); expect(catalog.maxOutputTokens).toBeUndefined();
    expect((await app.inject({ method: 'PUT', url: `/api/admin/models/${model.id}`, headers, payload: { ...blank, vision: false } })).statusCode).toBe(200);
    expect(gateway.channels(f.store.model(model.id)!, 'responses', true)).toHaveLength(0);
    expect(gateway.channels(f.store.model(model.id)!, 'responses', false)).toHaveLength(2);
  } finally { await app.close(); f.store.close(); }
});

test('legacy route eligibility is not expanded by migration', async () => {
  const f = await fixture();
  const { app, gateway } = await createApp({ ...f, publicUrl: 'http://localhost' });
  try {
    f.store.saveModel({ ...f.model, contextWindow: 1000000, routes: [{ ...f.model.routes[0], contextWindow: 256000 }, { ...f.model.routes[1], contextWindow: 1000000 }] });
    const before = gateway.channels(f.store.model(f.model.id)!, 'responses').map(c => c.key.id);
    f.store.migrateModelCapabilities();
    expect(gateway.channels(f.store.model(f.model.id)!, 'responses').map(c => c.key.id)).toEqual(before);
    expect(before).toEqual(['v1']);
  } finally { await app.close(); f.store.close(); }
});
