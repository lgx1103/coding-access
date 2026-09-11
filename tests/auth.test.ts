import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.js';
import { fixture, completion } from './helpers.js';
import type { Store } from '../src/server/db.js';
const cleanup: (() => Promise<void>)[] = []; afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
async function setup() { const f = await fixture(); const { app } = await createApp({ store: f.store, box: f.box, publicUrl: 'https://company.test', gateway: { fetch: async () => Response.json(completion()) } }); cleanup.push(async () => { await app.close(); f.store.close(); }); return { ...f, app }; }
describe('account and credential boundaries', () => {
  test('member creation rejects seven characters and accepts an eight-character initial password', async () => {
    const f = await setup(); const headers = { authorization: `Bearer ${f.adminSession}` };
    const member = { username: 'eight-char', name: '八位密码测试' };
    const short = await f.app.inject({ method: 'POST', url: '/api/admin/users', headers, payload: { ...member, password: 'Start12' } });
    expect(short.statusCode).toBe(400); expect(short.json().error.message).toContain('至少填写 8 个字符');
    expect(f.store.userByName(member.username)).toBeUndefined();
    const created = await f.app.inject({ method: 'POST', url: '/api/admin/users', headers, payload: { ...member, password: 'Start123' } });
    expect(created.statusCode).toBe(200); expect(created.json().user.mustChangePassword).toBe(true);
    expect(created.body).not.toContain('Start123'); expect(created.json().user).not.toHaveProperty('passwordHash');
    const login = await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: member.username, password: 'Start123' } });
    expect(login.statusCode).toBe(200); expect(login.json().user.mustChangePassword).toBe(true);
  });
  test('first password change accepts eight characters while rejected shorter passwords preserve the old login', async () => {
    const f = await setup(); f.store.saveUser({ ...f.employee, mustChangePassword: true });
    const token = f.store.issue(f.employee.id, 'session', 'password-test').token; const headers = { authorization: `Bearer ${token}` };
    const short = await f.app.inject({ method: 'POST', url: '/api/auth/password', headers, payload: { currentPassword: 'TestPassword123!', newPassword: 'NewPass' } });
    expect(short.statusCode).toBe(400); expect(short.json().error.message).toContain('至少填写 8 个字符');
    expect(f.store.user(f.employee.id)?.passwordHash).toBe(f.employee.passwordHash);
    expect(f.store.user(f.employee.id)?.mustChangePassword).toBe(true);
    const changed = await f.app.inject({ method: 'POST', url: '/api/auth/password', headers, payload: { currentPassword: 'TestPassword123!', newPassword: 'NewPass8' } });
    expect(changed.statusCode).toBe(200); expect(f.store.user(f.employee.id)?.mustChangePassword).toBe(false);
    expect((await f.app.inject({ url: '/api/models', headers })).statusCode).toBe(200);
    for (const [password, statusCode] of [['TestPassword123!', 401], ['NewPass8', 200]] as const) {
      expect((await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: f.employee.username, password } })).statusCode).toBe(statusCode);
    }
  });
  test('eight-character admin resets revoke old credentials, while rejected seven-character resets do not', async () => {
    const f = await setup(); const token = f.store.issue(f.employee.id, 'session', 'reset-test').token;
    const request = { method: 'POST' as const, url: `/api/admin/users/${f.employee.id}/reset-password`, headers: { authorization: `Bearer ${f.adminSession}` } };
    const short = await f.app.inject({ ...request, payload: { password: 'Reset12' } });
    expect(short.statusCode).toBe(400); expect(short.json().error.message).toContain('至少填写 8 个字符');
    expect(f.store.user(f.employee.id)?.passwordHash).toBe(f.employee.passwordHash);
    expect(f.store.authenticate(f.apiKey, 'api')).toBeTruthy(); expect(f.store.authenticate(token, 'session')).toBeTruthy();
    expect((await f.app.inject({ ...request, payload: { password: 'Reset123' } })).statusCode).toBe(200);
    expect(f.store.authenticate(f.apiKey, 'api')).toBeUndefined(); expect(f.store.authenticate(token, 'session')).toBeUndefined();
    const login = await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: f.employee.username, password: 'Reset123' } });
    expect(login.statusCode).toBe(200); expect(login.json().user.mustChangePassword).toBe(true);
  });
  test('production HTTP internal address supports browser and desktop login with origin checks', async () => {
    const f = await fixture(); const publicUrl = 'http://10.20.30.40:4317';
    const { app } = await createApp({ store: f.store, box: f.box, publicUrl });
    cleanup.push(async () => { await app.close(); f.store.close(); });
    const payload = { username: 'admin', password: 'TestPassword123!', client: 'browser', device: 'browser' };
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: publicUrl }, payload });
    expect(login.statusCode).toBe(200); expect(login.cookies[0].secure).not.toBe(true); expect(login.cookies[0].httpOnly).toBe(true);
    const browser = await app.inject({ url: '/api/admin/providers', cookies: { aca_session: login.cookies[0].value } });
    expect(browser.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'http://different.company.internal' }, payload })).statusCode).toBe(403);
    const desktop = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { ...payload, client: 'desktop', device: 'http-desktop' } });
    expect(desktop.statusCode).toBe(200);
    const issued = await app.inject({ method: 'POST', url: '/api/credentials', headers: { authorization: `Bearer ${desktop.json().sessionToken}` } });
    expect(issued.statusCode).toBe(200); expect(issued.json().baseUrl).toBe(publicUrl);
    expect((await app.inject({ url: '/v1/models', headers: { authorization: `Bearer ${issued.json().apiKey}` } })).statusCode).toBe(200);
  });
  test('employees cannot read admin resources, real keys or other employee usage', async () => {
    const f = await setup(); const token = f.store.issue(f.employee.id, 'session', 'browser').token; const headers = { authorization: `Bearer ${token}` };
    for (const url of ['/api/admin/keys', '/api/admin/providers', '/api/admin/users', '/api/admin/requests', '/api/admin/audit']) expect((await f.app.inject({ url, headers })).statusCode).toBe(403);
    const catalog = await f.app.inject({ url: '/api/models?agent=claude-code', headers }); expect(catalog.statusCode).toBe(200); expect(catalog.body).not.toMatch(/vendor-secret|providerId|zhipu|encryptedSecret/);
    const stats = await f.app.inject({ url: '/api/me/stats', headers }); expect(stats.json()).not.toHaveProperty('providers');
    f.store.beginRequest(f.admin.id, 'glm-test', 'claude-code'); const requests = await f.app.inject({ url: `/api/me/requests?userId=${f.admin.id}`, headers }); expect(requests.json().requests).toHaveLength(0);
  });
  test('offboarding revokes existing API and UI access while preserving other users', async () => {
    const f = await setup(); const unaffected = f.store.issue(f.admin.id, 'api', 'another-device').token; const userSession = f.store.issue(f.employee.id, 'session', 'desktop').token;
    const res = await f.app.inject({ method: 'PUT', url: `/api/admin/users/${f.employee.id}`, headers: { authorization: `Bearer ${f.adminSession}` }, payload: { name: '开发同事', role: 'employee', enabled: false } }); expect(res.statusCode).toBe(200);
    expect(f.store.authenticate(f.apiKey, 'api')).toBeUndefined(); expect(f.store.authenticate(userSession, 'session')).toBeUndefined(); expect(f.store.authenticate(unaffected, 'api')).toBeTruthy();
  });
  test('initial password gates credential issuing and model access; admin resets revoke old credentials', async () => {
    const f = await setup(); f.store.saveUser({ ...f.employee, mustChangePassword: true }); const token = f.store.issue(f.employee.id, 'session', 'device').token;
    expect((await f.app.inject({ url: '/api/models', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url: '/api/credentials', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url: '/api/auth/password', headers: { authorization: `Bearer ${token}` }, payload: { currentPassword: 'TestPassword123!', newPassword: 'NewPassword123!' } })).statusCode).toBe(200);
    expect((await f.app.inject({ url: '/api/models', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    await f.app.inject({ method: 'POST', url: `/api/admin/users/${f.employee.id}/reset-password`, headers: { authorization: `Bearer ${f.adminSession}` }, payload: { password: 'ResetPassword123!' } }); expect(f.store.authenticate(f.apiKey, 'api')).toBeUndefined();
  });
  test('expired UI session leaves company API credential working; explicit device logout revokes it', async () => {
    const f = await setup(); const session = f.store.issue(f.employee.id, 'session', 'test-device'); f.store.db.prepare('UPDATE tokens SET expires_at=0 WHERE id=?').run(session.id);
    expect(f.store.authenticate(session.token, 'session')).toBeUndefined(); expect(f.store.authenticate(f.apiKey, 'api')).toBeTruthy();
    const other = f.store.issue(f.employee.id, 'api', 'second-device').token;
    const response = await f.app.inject({ method: 'POST', url: '/api/auth/device-logout', headers: { authorization: `Bearer ${f.apiKey}` } }); expect(response.statusCode).toBe(200); expect(f.store.authenticate(f.apiKey, 'api')).toBeUndefined(); expect(f.store.authenticate(other, 'api')).toBeTruthy();
  });
  test('foreign origin changes are refused and browser sessions cannot issue agent credentials', async () => {
    const f = await setup(); const token = f.store.issue(f.employee.id, 'session', 'browser').token;
    expect((await f.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { authorization: `Bearer ${token}`, origin: 'https://evil.test' } })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url: '/api/credentials', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(400);
  });
  test('batch import is atomic and duplicate keys do not create partial rows', async () => {
    const f = await setup(); const template = { providerId: 'zhipu', name: 'new', secret: 'duplicate-test-key', maxConcurrent: 1, weight: 1, models: [], rateScope: 'key', group: '' };
    const response = await f.app.inject({ method: 'POST', url: '/api/admin/keys', headers: { authorization: `Bearer ${f.adminSession}` }, payload: { keys: [template, template] } }); expect(response.statusCode).toBe(409); expect(f.store.keys()).toHaveLength(3);
    const listing = await f.app.inject({ url: '/api/admin/keys', headers: { authorization: `Bearer ${f.adminSession}` } }); expect(listing.body).not.toMatch(/vendor-secret|encryptedSecret|secretHash/);
  });
  test('configuration verification matches the tool family and model, not only the device token', async () => {
    const f = await setup(); const session = f.store.issue(f.employee.id, 'session', 'test-device'); const credential = f.store.authenticate(f.apiKey, 'api')!;
    const requestId = f.store.beginRequest(f.employee.id, 'glm-test', 'codex', credential.credentialId); f.store.finishRequest(requestId, 'success');
    const url = `/api/me/credential-status?credentialId=${credential.credentialId}&modelId=glm-test&since=0&agent=`;
    const headers = { authorization: `Bearer ${session.token}` };
    expect((await f.app.inject({ url: url + 'claude-code', headers })).json().request).toBeNull();
    expect((await f.app.inject({ url: url + 'zcode', headers })).json().request).toBeNull();
    expect((await f.app.inject({ url: url + 'codex-cli', headers })).json().request.id).toBe(requestId);
    expect((await f.app.inject({ url: url + 'codex-desktop', headers })).json().request.id).toBe(requestId);
  });
});

test('session-only password change requires an enabled session and remains compatible with old clients', async () => {
  const f = await setup();
  const url = '/api/auth/password', payload = { newPassword: 'NewPass123!' };
  expect((await f.app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
  expect((await f.app.inject({ method: 'POST', url, payload, headers: { authorization: `Bearer ${f.apiKey}` } })).statusCode).toBe(401);
  const session = f.store.issue(f.employee.id, 'session', 'self-service').token;
  const headers = { authorization: `Bearer ${session}` };
  expect((await f.app.inject({ method: 'POST', url, payload: { newPassword: 'short' }, headers })).statusCode).toBe(400);
  expect((await f.app.inject({ method: 'POST', url, payload, headers: { ...headers, origin: 'https://attacker.test' } })).statusCode).toBe(403);
  expect((await f.app.inject({ method: 'POST', url, payload: { ...payload, currentPassword: 'wrong' }, headers })).statusCode).toBe(400);
  expect((await f.app.inject({ method: 'POST', url, payload, headers })).statusCode).toBe(200);
  expect((await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: f.employee.username, password: 'NewPass123!' } })).statusCode).toBe(200);
  expect((await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: f.employee.username, password: 'TestPassword123!' } })).statusCode).toBe(401);
  expect((await f.app.inject({ url: '/api/auth/me', headers })).statusCode).toBe(200);
  f.store.saveUser({ ...f.store.userByName(f.employee.username)!, enabled: false });
  expect((await f.app.inject({ method: 'POST', url, payload, headers })).statusCode).toBe(401);
});
