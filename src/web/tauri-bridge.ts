import { invoke, isTauri } from '@tauri-apps/api/core';
import type { DesktopBridge } from './api';

/** Keeps tokens, HTTP, file access and process launch behind typed native commands. */
export function tauriBridge(): DesktopBridge | undefined {
  if (!isTauri()) return undefined;
  async function call<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    try { return await invoke<T>('coding_access', { request: { action, ...args } }); }
    catch (error) { throw error instanceof Error ? error : new Error(typeof error === 'string' ? error : '操作失败，请重试'); }
  }
  return {
    migration: {
      retry: () => call('retryUpgrade'),
      status: () => call('migrationStatus'),
      preview: sourceId => call('previewMigration', { sourceId }),
      import: (sourceId, fingerprint) => call('importMigration', { sourceId, fingerprint }),
      undo: () => call('undoMigration'),
    },
    update: operation => call('update', { operation }),
    getSettings: () => call('getSettings'),
    saveSettings: preferences => call('saveSettings', { preferences }),
    testConnection: serverUrl => call('testConnection', { serverUrl }),
    saveText: (name, contents) => call('saveText', { name, contents }),
    getState: () => call('getState'),
    getRememberedLogin: (serverUrl, username) => call('getRememberedLogin', { serverUrl, username }),
    forgetLogin: (serverUrl, username) => call('forgetLogin', { serverUrl, username }),
    clearSavedLogins: () => call('clearSavedLogins'),
    login: (serverUrl, username, password, remember = false, useSaved = false) => call('login', { serverUrl, username, password, remember, useSaved }),
    logout: () => call('logout'),
    request: (path, method = 'GET', body) => call('request', { path, method, body }),
    inspect: agent => call('inspect', { agent }),
    apply: (agent, modelId) => call('apply', { agent, modelId }),
    restore: agent => call('restore', { agent }),
    chooseDirectory: () => call('chooseDirectory'),
    launch: (agent, modelId) => call('launch', { agent, modelId }),
    download: path => call('download', { path }),
    copyText: value => call('copyText', { value }),
  };
}
