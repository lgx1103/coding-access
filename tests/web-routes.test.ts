import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { WEB_PAGE_PATHS, isWebPagePath, webPageAt, webPagePath } from '../src/shared/web-routes.js';
import { fixture } from './helpers.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

test('browser routes restore the selected page and cannot select another role’s pages', () => {
  expect(webPageAt('/admin/users', 'admin')).toBe('users');
  expect(webPageAt('/admin/keys/', 'admin')).toBe('resources');
  expect(webPagePath('requests', 'admin')).toBe('/admin/usage');
  expect(webPageAt('/app/usage', 'employee')).toBe('usage');
  expect(webPageAt('/admin/users', 'employee')).toBe('overview');
  expect(webPagePath('users', 'employee')).toBe('/app/models');
  expect(webPagePath('__proto__', 'admin')).toBe('/admin/overview');
  expect(webPageAt('/admin/not-a-page', 'admin')).toBe('overview');
  expect(webPageAt('/', 'admin')).toBe('overview');
  expect(isWebPagePath('/api/admin/users')).toBe(false);
  expect(isWebPagePath('/assets/missing.js')).toBe(false);
});

async function server(withIndex = true) {
  const dir = mkdtempSync(join(tmpdir(), 'coding-access-web-routes-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  if (withIndex) writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><script src="./assets/app.js"></script></head><body><div id="root">test-shell</div></body></html>');
  const f = await fixture(); cleanup.push(() => f.store.close());
  const { app } = await createApp({ ...f, publicUrl: 'http://localhost', webRoot: dir, downloadsRoot: join(dir, 'downloads'), updatesRoot: join(dir, 'updates') });
  cleanup.push(() => app.close());
  return app;
}

test('refresh and direct navigation serve the app shell for every registered browser page', async () => {
  const app = await server();
  for (const path of WEB_PAGE_PATHS) {
    for (const suffix of ['', '/', '?source=bookmark']) {
      const res = await app.inject({ url: path + suffix });
      expect(res.statusCode, path + suffix).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('test-shell');
      expect(res.body).toContain('<base href="/">');
      expect(res.body.indexOf('<base href="/">')).toBeLessThan(res.body.indexOf('<script'));
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  }
  const head = await app.inject({ method: 'HEAD', url: '/admin/users' });
  expect(head.statusCode).toBe(200); expect(head.body).toBe('');
});

test('SPA handling keeps missing APIs, assets and invalid methods as real errors, and preserves authorization', async () => {
  const app = await server();
  for (const url of ['/api/not-found', '/v1/not-found', '/assets/missing.js', '/admin/not-a-page', '/client-artifacts/not-found/file.exe']) {
    const res = await app.inject({ url });
    expect(res.statusCode, url).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).not.toContain('test-shell');
  }
  expect((await app.inject({ method: 'POST', url: '/admin/users', payload: {} })).statusCode).toBe(404);
  expect((await app.inject({ url: '/api/admin/users' })).statusCode).toBe(401);
});

test('a missing frontend build remains a 404 instead of falling back recursively', async () => {
  const app = await server(false);
  expect((await app.inject({ url: '/admin/users' })).statusCode).toBe(404);
});
