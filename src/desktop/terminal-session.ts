import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import type { EmployeeModel } from '../shared/types.js';
import { atomicWrite, claudeConfiguration } from './config.js';

export type TerminalAgent = 'claude-code' | 'codex-cli';
export interface TerminalSessionInput { agent: TerminalAgent; executable: string; project: string; model: EmployeeModel; baseUrl: string; credential: string }
export interface TerminalSession { directory: string; payloadPath: string }
export interface SessionCommand { executable: string; project: string; args: string[]; env: Record<string, string>; label: string }
const sessionName = /^session-[a-f0-9-]{36}$/;
const sessionFiles = ['launch.json', 'claimed.json', 'claude-settings.json', 'launch.command', 'owner.json'];

// Only remove files owned by this launcher, never a project or CLI history directory.
export function discardTerminalSession(directory: string) {
  if (!sessionName.test(basename(directory)) || !existsSync(directory) || lstatSync(directory).isSymbolicLink()) return;
  for (const name of sessionFiles) { try { unlinkSync(join(directory, name)); } catch { /* Already removed or still inaccessible. */ } }
  try { rmdirSync(directory); } catch { /* Preserve unexpected files. */ }
}
export function cleanStaleTerminalSessions(stateDirectory: string, now = Date.now()) {
  const root = join(stateDirectory, 'terminal-sessions');
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !sessionName.test(entry.name)) continue;
    const directory = join(root, entry.name);
    try {
      const owner = JSON.parse(readFileSync(join(directory, 'owner.json'), 'utf8'));
      if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); continue; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
      } else if (!Number.isFinite(owner.createdAt) || now - owner.createdAt < 24 * 60 * 60 * 1000) continue;
      discardTerminalSession(directory);
    } catch { /* Unknown directory contents are not ours to remove. */ }
  }
}
export function createTerminalSession(stateDirectory: string, input: TerminalSessionInput): TerminalSession {
  if (!['claude-code', 'codex-cli'].includes(input.agent)) throw new Error('该工具不支持临时终端会话');
  if (/[\r\n\0]/.test(input.executable + input.project) || !input.credential || !input.model.id) throw new Error('临时会话配置无效');
  const directory = join(stateDirectory, 'terminal-sessions', `session-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const payloadPath = join(directory, 'launch.json');
  try {
    atomicWrite(join(directory, 'owner.json'), JSON.stringify({ createdAt: Date.now(), pid: null }));
    atomicWrite(payloadPath, JSON.stringify(input));
    return { directory, payloadPath };
  } catch (e) { discardTerminalSession(directory); throw e; }
}
export function claimTerminalSession(payloadPath: string): { directory: string; command: SessionCommand } {
  const path = resolve(payloadPath); const directory = dirname(path);
  if (basename(path) !== 'launch.json' || !sessionName.test(basename(directory)) || lstatSync(directory).isSymbolicLink()) throw new Error('临时会话路径无效');
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new Error('临时会话已使用或已过期，请从客户端重新打开');
  const claimed = join(directory, 'claimed.json');
  renameSync(path, claimed); // Each launch is consumed once, even if its terminal opens twice.
  try {
    atomicWrite(join(directory, 'owner.json'), JSON.stringify({ createdAt: Date.now(), pid: process.pid }));
    const input: TerminalSessionInput = JSON.parse(readFileSync(claimed, 'utf8'));
    unlinkSync(claimed);
    return { directory, command: sessionCommand(directory, input) };
  } catch (e) { discardTerminalSession(directory); throw e; }
}
export function sessionCommand(directory: string, input: TerminalSessionInput): SessionCommand {
  const { agent, executable, project, model, baseUrl, credential } = input;
  if (!['claude-code', 'codex-cli'].includes(agent) || !executable || !project || !credential || !model?.id) throw new Error('临时会话配置无效');
  if (agent === 'claude-code') {
    const settings = JSON.parse(claudeConfiguration('{}', baseUrl, credential, model));
    // Clear limits inherited from the saved default when this temporary model
    // has no declared capacity. Empty values mean unset to Claude Code.
    settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = model.contextWindow === undefined ? '' : String(model.contextWindow);
    settings.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = model.maxOutputTokens === undefined ? '' : String(model.maxOutputTokens);
    // These are routing overrides, not permission or policy overrides.
    Object.assign(settings.env, { CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0', ANTHROPIC_CUSTOM_HEADERS: '' });
    const settingsPath = join(directory, 'claude-settings.json');
    atomicWrite(settingsPath, JSON.stringify(settings));
    return { executable, project, args: ['--settings', settingsPath, '--model', model.id], env: { ...settings.env }, label: model.name };
  }
  // A distinct provider prevents merging with a saved provider's auth or headers.
  const provider = `coding_access_session_${basename(directory).replaceAll('-', '_')}`;
  const overrides: Record<string, string | number | boolean> = {
    model: model.id, model_provider: provider, web_search: 'disabled',
    'features.enable_request_compression': false, 'features.respect_system_proxy': true,
    [`model_providers.${provider}.name`]: 'Coding Access', [`model_providers.${provider}.base_url`]: `${baseUrl.replace(/\/$/, '')}/v1`,
    [`model_providers.${provider}.wire_api`]: 'responses', [`model_providers.${provider}.env_key`]: 'CODING_ACCESS_SESSION_TOKEN',
    [`model_providers.${provider}.requires_openai_auth`]: false, [`model_providers.${provider}.supports_websockets`]: false,
    [`model_providers.${provider}.request_max_retries`]: 0, [`model_providers.${provider}.stream_max_retries`]: 0,
  };
  if (model.contextWindow !== undefined) {
    overrides.model_context_window = model.contextWindow;
    overrides.model_auto_compact_token_limit = Math.max(1024, Math.floor(model.contextWindow * .8));
  }
  return { executable, project, args: Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]), env: { CODING_ACCESS_SESSION_TOKEN: credential }, label: model.name };
}
