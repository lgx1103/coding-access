import { afterEach, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'dotenv';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() { const path = mkdtempSync(join(tmpdir(), 'coding-access-setup-')); directories.push(path); return path; }
function setup(cwd: string, url = 'http://10.20.30.40:4317') {
  return spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/setup.ts'), '--docker', url], { cwd, encoding: 'utf8' });
}
test('Docker initialization produces an internal HTTP deployment without host Node installation steps', () => {
  const cwd = directory(); const result = setup(cwd); expect(result.status).toBe(0);
  const env = parse(readFileSync(join(cwd, '.env')));
  expect(env).toMatchObject({ ACA_PUBLIC_URL: 'http://10.20.30.40:4317', ACA_BIND_ADDRESS: '10.20.30.40', ACA_PUBLIC_PORT: '4317', NODE_ENV: 'production' });
  expect(Buffer.from(env.ACA_MASTER_KEY, 'base64')).toHaveLength(32);
  expect(readFileSync(join(cwd, '.local/initial-credentials.txt'), 'utf8')).toContain(env.ACA_ADMIN_PASSWORD);
  expect(result.stdout).not.toContain(env.ACA_MASTER_KEY); expect(result.stdout).not.toContain(env.ACA_ADMIN_PASSWORD);
});
test('Docker initialization preserves existing configuration, database and credentials independently', () => {
  for (const file of ['.env', '.local/access.sqlite', '.local/initial-credentials.txt']) {
    const cwd = directory(); mkdirSync(join(cwd, '.local'));
    writeFileSync(join(cwd, file), 'existing-data'); expect(setup(cwd).status).not.toBe(0);
    expect(readFileSync(join(cwd, file), 'utf8')).toBe('existing-data');
    if (file !== '.env') expect(existsSync(join(cwd, '.env'))).toBe(false);
  }
});
test('invalid Docker public addresses fail before creating any credentials', () => {
  for (const url of ['https://10.20.30.40', 'http://company.internal:4317', 'http://10.20.30.40/v1', 'http://user:pass@10.20.30.40', 'not-a-url']) {
    const cwd = directory(); expect(setup(cwd, url).status).not.toBe(0);
    expect(existsSync(join(cwd, '.env'))).toBe(false); expect(existsSync(join(cwd, '.local'))).toBe(false);
  }
});

// POSIX permission bits and umask are not supported by Windows.
test.skipIf(process.platform === 'win32')('Docker initialization keeps only public release directory readable under restrictive umask', () => {
  const previous = process.umask(0o077);
  try {
    const cwd = directory(); expect(setup(cwd).status).toBe(0);
    expect(statSync(join(cwd, 'release')).mode & 0o777).toBe(0o755);
    expect(statSync(join(cwd, '.env')).mode & 0o777).toBe(0o600);
    expect(statSync(join(cwd, '.local')).mode & 0o777).toBe(0o700);
  } finally { process.umask(previous); }
});
