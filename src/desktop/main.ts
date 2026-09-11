import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell, net, clipboard } from 'electron';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomicWrite, ConfigManager } from './config.js';
import { locateTool, launchTool, toolVersion, zcodeRunning } from './launch.js';
import { cleanStaleTerminalSessions, createTerminalSession, discardTerminalSession } from './terminal-session.js';
import type { AgentId, EmployeeModel } from '../shared/types.js';
import { AGENT_IDS, isCodexAgent, isDesktopAgent } from '../shared/types.js';
import { serviceBaseUrl as baseUrl } from '../shared/service-url.js';

interface Secrets { serverUrl: string; device: string; session?: string; userId?: string; apiKey?: string; credentialId?: string }
interface Preferences { serverUrl: string; projectDirectory: string }
const testingHome = !app.isPackaged ? process.env.ACA_DESKTOP_TEST_HOME : undefined;
if (testingHome) app.setPath('userData', resolve(testingHome, 'desktop-data'));
if (!app.requestSingleInstanceLock()) app.quit();
let window: BrowserWindow | null = null;
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
app.on('window-all-closed', () => app.quit());
async function main() {
await app.whenReady();
const dataDirectory = app.getPath('userData'); mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
cleanStaleTerminalSessions(dataDirectory);
const fetch = net.fetch.bind(net);
const secretsFile = join(dataDirectory, 'credentials.enc'); const preferencesFile = join(dataDirectory, 'preferences.json');
let preferences: Preferences = existsSync(preferencesFile) ? JSON.parse(readFileSync(preferencesFile, 'utf8')) : { serverUrl: '', projectDirectory: '' };
let secrets: Secrets = { serverUrl: '', device: randomUUID() };
if (existsSync(secretsFile)) {
  try { const decrypted = await safeStorage.decryptStringAsync(readFileSync(secretsFile)); secrets = JSON.parse(decrypted.result); if (decrypted.shouldReEncrypt) atomicWrite(secretsFile, await safeStorage.encryptStringAsync(decrypted.result)); }
  catch { await dialog.showMessageBox({ type: 'error', title: '无法读取登录凭证', message: '系统凭证存储解密失败，请重新登录。现有工具配置仍保留。' }); }
}
const config = new ConfigManager(testingHome ?? homedir(), dataDirectory, testingHome ? { ...process.env, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', ZCODE_DATA_BASE_DIR: '' } : process.env);
async function saveSecrets() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储当前不可用，请解锁系统密钥链后重试');
  atomicWrite(secretsFile, await safeStorage.encryptStringAsync(JSON.stringify(secrets)));
}
function savePreferences() { atomicWrite(preferencesFile, JSON.stringify(preferences, null, 2)); }
async function request(path: string, method = 'GET', body?: unknown, override?: { url: string; token?: string }) {
  if (!/^\/api\/(?:meta(?:\?|$)|client-release$|auth\/(?:me|password|logout)(?:\?|$)|models(?:\?|$)|me\/(?:stats|requests|credential-status)(?:\?|$)|credentials(?:\?|$)|admin\/[A-Za-z0-9/_?.=&%+-]+$)/.test(path)) throw new Error('客户端不支持该接口');
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) throw new Error('不支持的请求方法');
  const base = override?.url ?? preferences.serverUrl; if (!base) throw new Error('请先填写公司服务地址并登录');
  const token = override ? override.token : secrets.serverUrl === base ? secrets.session : undefined;
  const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30_000) });
  let data: any; try { data = await response.json(); } catch { throw new Error(`公司服务返回了无效响应（${response.status}）`); }
  if (!response.ok) throw new Error(data.error?.message ?? `请求失败（${response.status}）`);
  return data;
}
async function revokeCurrent() {
  if (!secrets.session && !secrets.apiKey) return;
  // API-key self-revocation also works after the UI login session has expired.
  const token = secrets.apiKey ?? secrets.session;
  const response = await fetch(`${secrets.serverUrl}/api/auth/device-logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (![200, 401].includes(response.status)) throw new Error('公司服务未确认凭证撤销，请连接公司网络后重新退出');
  secrets = { serverUrl: preferences.serverUrl, device: secrets.device }; await saveSecrets();
}
const agentSchema = z.enum(AGENT_IDS);
async function availableModel(agent: AgentId, modelId: string): Promise<EmployeeModel> {
  const catalog = await request(`/api/models?agent=${agent}`);
  const model = catalog.models.find((m: EmployeeModel) => m.id === modelId);
  if (!model) throw new Error('该模型已不在可用目录，请刷新后重新选择');
  return model;
}
async function accessCredential() {
  let valid = false;
  if (secrets.apiKey) {
    const response = await fetch(`${preferences.serverUrl}/v1/models`, { headers: { authorization: `Bearer ${secrets.apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    valid = response.ok;
    if (!valid && ![401, 403].includes(response.status)) throw new Error('公司服务暂时无法验证访问凭证，请稍后重试');
  }
  if (!valid) { const issued = await request('/api/credentials', 'POST'); secrets.apiKey = issued.apiKey; secrets.credentialId = issued.credentialId; await saveSecrets(); }
  return { apiKey: secrets.apiKey!, credentialId: secrets.credentialId! };
}
const index = join(__dirname, '../web/index.html'); const trustedPage = pathToFileURL(index).href;
function handle(name: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(`coding-access:${name}`, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== trustedPage) throw new Error('请求来源不受信任');
    try { return await fn(...args); } catch (e) { throw new Error(e instanceof Error ? e.message : '操作失败'); }
  });
}
handle('copyText', (value: unknown) => { clipboard.writeText(z.string().min(1).max(64 * 1024).parse(value)); });
handle('getState', () => ({ ...preferences, version: app.getVersion(), platform: process.platform, configured: Object.fromEntries(Object.entries(config.configured()).map(([agent, record]) => [agent, { ...record, needsUpdate: !config.isApplied(agent as AgentId, record.modelId) || record.credentialId !== secrets.credentialId }])) }));
handle('login', async (url: string, username: string, password: string) => {
  const base = baseUrl(url); z.string().min(1).max(80).parse(username); z.string().min(1).max(256).parse(password);
  if (secrets.serverUrl && secrets.serverUrl !== base && (secrets.session || secrets.apiKey)) await revokeCurrent();
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password, client: 'desktop', device: secrets.device }), redirect: 'error', signal: AbortSignal.timeout(20_000) });
  const result: any = await response.json(); if (!response.ok) throw new Error(result.error?.message ?? '登录失败');
  if (secrets.userId && secrets.userId !== result.user.id) await revokeCurrent();
  secrets = { ...secrets, serverUrl: base, userId: result.user.id, session: result.sessionToken }; preferences.serverUrl = base;
  await saveSecrets(); savePreferences(); return { user: result.user };
});
handle('logout', revokeCurrent);
handle('request', (path: string, method?: string, body?: unknown) => request(z.string().max(4096).parse(path), method, body));
handle('download', async (path: unknown) => { const validated = z.string().regex(/^\/downloads\/Coding-Access-[0-9A-Za-z.-]+-(win|mac)-(x64|arm64)\.zip$/).parse(path); const release = await request('/api/client-release'); if (!release.downloads.some((d: any) => d.url === validated)) throw new Error('安装包已变更，请刷新后重试'); await shell.openExternal(`${baseUrl(preferences.serverUrl)}${validated}`); });
handle('inspect', async (raw: unknown) => {
  const agent = agentSchema.parse(raw); const executable = await locateTool(agent, testingHome ?? homedir());
  return { installed: Boolean(executable), version: executable && agent !== 'zcode' ? await toolVersion(executable) : null, path: config.path(agent), sharedWith: isCodexAgent(agent) ? [agent === 'codex-cli' ? 'Codex 桌面版' : 'Codex CLI'] : [], warnings: config.warnings(agent, preferences.projectDirectory) };
});
handle('apply', async (raw: unknown, modelId: string) => {
  const agent = agentSchema.parse(raw); z.string().max(128).parse(modelId);
  if (agent === 'zcode' && !testingHome && await zcodeRunning()) throw new Error('请先完全退出 ZCode，再应用模型，避免配置被正在运行的应用覆盖');
  const model = await availableModel(agent, modelId);
  const credential = await accessCredential();
  return config.apply(agent, model, preferences.serverUrl, credential.apiKey, credential.credentialId);
});
handle('restore', async (raw: unknown) => { const agent = agentSchema.parse(raw); if (agent === 'zcode' && !testingHome && await zcodeRunning()) throw new Error('请先完全退出 ZCode，再恢复配置'); return config.restore(agent); });
handle('chooseDirectory', async () => { const result = await dialog.showOpenDialog(window!, { title: '选择项目目录', properties: ['openDirectory'], defaultPath: preferences.projectDirectory || (testingHome ?? homedir()) }); if (result.canceled) return null; preferences.projectDirectory = result.filePaths[0]; savePreferences(); return preferences.projectDirectory; });
handle('launch', async (raw: unknown, selectedModel: unknown) => {
  const agent = agentSchema.parse(raw); const modelId = z.string().min(1).max(128).parse(selectedModel);
  const path = await locateTool(agent, testingHome ?? homedir());
  if (!path) throw new Error('未检测到工具，请先安装，或手动打开已安装的应用');
  if (isDesktopAgent(agent)) {
    config.assertApplied(agent, modelId);
    if (!secrets.apiKey || config.configured()[agent]?.credentialId !== secrets.credentialId) throw new Error('请先启用所选模型，更新当前账号的访问凭证');
  }
  if (!app.isPackaged && process.env.ACA_DESKTOP_DISABLE_LAUNCH === '1') throw new Error('测试模式不会启动真实编程工具');
  if (isDesktopAgent(agent)) {
    config.assertApplied(agent, modelId);
    await launchTool(agent, path, preferences.projectDirectory, dataDirectory);
    return;
  }
  const model = await availableModel(agent, modelId);
  const credential = await accessCredential();
  const temporary = createTerminalSession(dataDirectory, { agent: agent as 'claude-code' | 'codex-cli', executable: path, project: preferences.projectDirectory, model, baseUrl: preferences.serverUrl, credential: credential.apiKey });
  try {
    await launchTool(agent, path, preferences.projectDirectory, dataDirectory, process.platform, { ...temporary, runtime: process.execPath, runner: join(__dirname, 'session-runner.cjs') });
  } catch (e) { discardTerminalSession(temporary.directory); throw e; }
});
session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
session.defaultSession.setPermissionCheckHandler(() => false);
window = new BrowserWindow({ width: 1360, height: 930, minWidth: 860, minHeight: 660, title: 'Coding Access', backgroundColor: '#f6f7f4', show: false, autoHideMenuBar: true, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
window.webContents.on('will-navigate', event => event.preventDefault());
window.once('ready-to-show', () => window?.show());
window.on('closed', () => { window = null; });
await window.loadFile(index);
}
void main().catch(async () => { await dialog.showMessageBox({ type: 'error', title: 'Coding Access 启动失败', message: '无法初始化本地应用数据，请检查用户目录权限或系统密钥链后重试。' }); app.quit(); });
