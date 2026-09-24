import { tauriBridge } from './tauri-bridge';
export interface DesktopState { development?: boolean; upgradeError?: string | null; upgradeIssues?: MigrationAgent[]; credentialExpired?: boolean; serverUrl: string; projectDirectory: string; version: string; platform: string; configured: Record<string, { modelId: string; modelName: string; appliedAt: number; path: string; credentialId: string; needsUpdate?: boolean }> }
export interface Inspection { executablePath?: string | null; installed: boolean; version: string | null; path: string; sharedWith: string[]; warnings: string[]; configuredModel?: string }
export interface MigrationAgent { agent: string; modelName: string; status: 'ready' | 'skipped'; message: string }
export interface MigrationReceipt { id: string; importedAt: number; sourceId: string; agents: MigrationAgent[]; needsLogin: boolean }
export interface MigrationStatus { development?: boolean; sources: { id: string; path: string }[]; imported: MigrationReceipt | null }
export interface MigrationPreview { sourceId: string; fingerprint: string; serverUrl: string; projectDirectory: string; agents: MigrationAgent[]; warnings: string[]; needsLogin: boolean }
export interface MigrationBridge {
  retry(): Promise<DesktopState>;
  status(): Promise<MigrationStatus>;
  preview(sourceId: string): Promise<MigrationPreview>;
  import(sourceId: string, fingerprint: string): Promise<MigrationReceipt>;
  undo(): Promise<void>;
}
export interface DesktopBridge {
  migration?: MigrationBridge;
  update?(operation: string): Promise<any>;
  getSettings?(): Promise<any>;
  saveSettings?(preferences: any): Promise<any>;
  testConnection?(serverUrl: string): Promise<any>;
  saveText?(name: string, contents: string): Promise<boolean>;
  getState(): Promise<DesktopState>;
  getRememberedLogin?(serverUrl: string, username?: string): Promise<{ username: string; remembered: boolean }>;
  forgetLogin?(serverUrl: string, username: string): Promise<void>;
  clearSavedLogins?(): Promise<void>;
  login(serverUrl: string, username: string, password: string, remember?: boolean, useSaved?: boolean): Promise<any>;
  logout(): Promise<void>;
  request(path: string, method?: string, body?: unknown): Promise<any>;
  inspect(agent: string): Promise<Inspection>;
  apply(agent: string, modelId: string): Promise<{ path: string; warnings: string[]; changed?: boolean }>;
  restore(agent: string): Promise<{ path: string }>;
  chooseDirectory(): Promise<string | null>;
  launch(agent: string, modelId: string): Promise<void>;
  download(path: string): Promise<void>;
  copyText(value: string): Promise<void>;
}
declare global { interface Window { codingAccess?: DesktopBridge } }
export const desktop = window.codingAccess ?? tauriBridge();
export async function copyText(value: string): Promise<void> {
  if (desktop) return desktop.copyText(value);
  try { await navigator.clipboard.writeText(value); }
  catch { throw new Error('无法复制，请检查剪贴板权限后重试。'); }
}
export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (desktop) return desktop.request(path, method, body).catch(error => { if (error instanceof Error && error.message.includes('请登录公司账号')) window.dispatchEvent(new Event('aca-auth-expired')); throw error; });
  const response = await fetch(path, { method, credentials: 'same-origin', headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== '/api/auth/login') window.dispatchEvent(new Event('aca-auth-expired')); throw new Error(data.error?.message ?? `请求失败（${response.status}）`); }
  return data;
}
export const number = (value: number | null | undefined) => value == null ? '—' : Intl.NumberFormat('zh-CN', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
export const dateTime = (value: number | null | undefined) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '尚无记录';
export const fullNumber = (value: number | null | undefined) => value == null ? '未知' : value.toLocaleString('zh-CN');

export async function changePassword(newPassword: string): Promise<{ warning?: string }> {
  const meta = await api('/api/meta');
  if (!meta.capabilities?.sessionPasswordChange) throw new Error('请管理员先升级服务端至 0.1.19，再使用此改密功能。');
  return api('/api/auth/password', 'POST', { newPassword });
}
