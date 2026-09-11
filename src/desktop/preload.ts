import { contextBridge, ipcRenderer } from 'electron';
import { userErrorMessage } from '../shared/error-message.js';
const invoke = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`coding-access:${name}`, ...args).catch(error => { throw new Error(userErrorMessage(error)); });
contextBridge.exposeInMainWorld('codingAccess', Object.freeze({
  getState: () => invoke('getState'), login: (url: string, username: string, password: string) => invoke('login', url, username, password), logout: () => invoke('logout'),
  request: (path: string, method?: string, body?: unknown) => invoke('request', path, method, body),
  inspect: (agent: string) => invoke('inspect', agent), apply: (agent: string, model: string) => invoke('apply', agent, model), restore: (agent: string) => invoke('restore', agent),
  chooseDirectory: () => invoke('chooseDirectory'), launch: (agent: string, modelId: string) => invoke('launch', agent, modelId),
  download: (path: string) => invoke('download', path),
  copyText: (value: string) => invoke('copyText', value),
}));
