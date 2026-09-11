import { afterEach, expect, test } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientReleases } from '../src/server/releases.js';
import { createApp } from '../src/server/app.js';
import { APP_VERSION } from '../src/shared/version.js';
import { userErrorMessage } from '../src/shared/error-message.js';
import { fixture } from './helpers.js';
const cleanups: (() => unknown)[] = []; afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
function dir() { const root = mkdtempSync(join(tmpdir(), 'aca-releases-')); cleanups.push(() => rmSync(root, { recursive: true, force: true })); return root; }
test('missing, empty and non-directory download roots produce controlled responses', async () => {
  const root = dir(); const file = join(root, 'not-a-directory'); writeFileSync(file, 'content');
  expect(clientReleases(join(root, 'missing'), APP_VERSION)).toEqual({ version: APP_VERSION, downloads: [], downloadIssue: undefined });
  expect(clientReleases(root, APP_VERSION).downloads).toEqual([]);
  expect(clientReleases(file, APP_VERSION).downloadIssue?.code).toBe('release_directory_unavailable');
  const f = await fixture(); cleanups.push(() => f.store.close());
  const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'http://localhost:4317', downloadsRoot: file }); cleanups.push(() => app.close());
  const response = await app.inject('/api/client-release'); expect(response.statusCode).toBe(200);
  expect(response.json().downloadIssue.message).toContain('目录'); expect(response.body).not.toContain(root);
  expect((await app.inject('/health')).statusCode).toBe(200);
});
test('only current-version regular readable ZIPs are offered; directories and links stay private', async () => {
  const root = dir(); const name = `Coding-Access-${APP_VERSION}-mac-arm64.zip`;
  writeFileSync(join(root, name), 'valid-zip'); writeFileSync(join(root, 'Coding-Access-0.0.0-win-x64.zip'), 'old');
  mkdirSync(join(root, `Coding-Access-${APP_VERSION}-win-arm64.zip`));
  symlinkSync(join(root, name), join(root, `Coding-Access-${APP_VERSION}-win-x64.zip`));
  symlinkSync(join(root, 'missing'), join(root, `Coding-Access-${APP_VERSION}-mac-x64.zip`));
  const f = await fixture(); cleanups.push(() => f.store.close());
  const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'http://localhost:4317', downloadsRoot: root }); cleanups.push(() => app.close());
  expect((await app.inject('/api/client-release')).json().downloads.map((d: any) => d.name)).toEqual([name]);
  const response = await app.inject(`/downloads/${name}`); expect(response.statusCode).toBe(200); expect(response.body).toBe('valid-zip');
  expect((await app.inject(`/downloads/Coding-Access-${APP_VERSION}-win-x64.zip`)).statusCode).toBe(404);
  expect((await app.inject('/downloads/%2E%2E%2F.env')).statusCode).toBe(404);
});
// chmod cannot model unreadable POSIX files on Windows.
test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('unreadable directory and file permissions return actionable status rather than generic 500', () => {
  const root = dir(); const name = join(root, `Coding-Access-${APP_VERSION}-win-x64.zip`); writeFileSync(name, 'test');
  chmodSync(name, 0); expect(clientReleases(root, APP_VERSION)).toMatchObject({ downloads: [], downloadIssue: { code: 'release_file_unavailable' } }); chmodSync(name, 0o644);
  chmodSync(root, 0); try { expect(clientReleases(root, APP_VERSION).downloadIssue?.code).toBe('release_directory_unavailable'); } finally { chmodSync(root, 0o755); }
});
test('Electron error display removes the known internal wrapper and preserves useful messages', () => {
  expect(userErrorMessage(new Error("Error invoking remote method 'coding-access:request': Error: 安装包目录无法读取"))).toBe('安装包目录无法读取');
  expect(userErrorMessage(new Error('请求处理失败，请检查输入或联系管理员'))).toBe('请求处理失败，请检查输入或联系管理员');
  expect(userErrorMessage('Error: 连接失败')).toBe('Error: 连接失败');
});
