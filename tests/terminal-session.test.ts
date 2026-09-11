import { afterEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, ConfigManager } from '../src/desktop/config.js';
import { cleanStaleTerminalSessions, claimTerminalSession, createTerminalSession, discardTerminalSession, type TerminalSessionInput } from '../src/desktop/terminal-session.js';
import { terminalScript } from '../src/desktop/launch.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function setup(agent: TerminalSessionInput['agent'] = 'claude-code') {
  const root = mkdtempSync(join(tmpdir(), 'coding-access-session-')); dirs.push(root);
  const manager = new ConfigManager(join(root, 'home'), join(root, 'state'), {});
  const input: TerminalSessionInput = { agent, executable: '/test/tool', project: root, baseUrl: 'http://company.test:4317', credential: 'private-company-token', model: { id: 'temporary-b', name: 'Temporary B', description: '', contextWindow: 128000, maxOutputTokens: 8192, agents: ['claude-code', 'codex-cli'], status: 'available', updatedAt: Date.now() } };
  return { root, manager, input };
}
describe('temporary terminal sessions', () => {
  test.each(['claude-code', 'codex-cli'] as const)('launching %s leaves default configuration and takeover records unchanged', agent => {
    const { root, manager, input } = setup(agent);
    manager.apply(agent, { ...input.model, id: 'default-a' }, input.baseUrl, input.credential, 'cred');
    const before = readFileSync(manager.path(agent)); const records = JSON.stringify(manager.configured());
    const session = createTerminalSession(root, input); const { command } = claimTerminalSession(session.payloadPath);
    expect(readFileSync(manager.path(agent))).toEqual(before); expect(JSON.stringify(manager.configured())).toBe(records);
    expect(command.args.join(' ')).not.toContain(input.credential);
    expect(command.args.join(' ')).toContain(input.model.id);
    expect(existsSync(session.payloadPath)).toBe(false);
    discardTerminalSession(session.directory); expect(existsSync(session.directory)).toBe(false);
  });
  test('Claude only overrides model, routing and known capacity, preserving lower-layer user customization', () => {
    const { root, input } = setup();
    const session = createTerminalSession(root, input); const { command } = claimTerminalSession(session.payloadPath);
    const settingsPath = command.args[1]; const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.model).toBe('temporary-b'); expect(settings.env.ANTHROPIC_MODEL).toBe('temporary-b');
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe(input.credential); expect(settings.env.ANTHROPIC_BASE_URL).toBe(input.baseUrl);
    expect(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('temporary-b'); expect(settings.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('temporary-b');
    expect(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('128000');
    for (const family of ['HAIKU', 'SONNET', 'OPUS', 'FABLE']) {
      expect(command.env[`ANTHROPIC_DEFAULT_${family}_MODEL`]).toBe('temporary-b');
      expect(command.env[`ANTHROPIC_DEFAULT_${family}_MODEL_NAME`]).toBe('Temporary B');
    }
    expect(settings.env.CLAUDE_CODE_USE_BEDROCK).toBe('0'); expect(settings.env.ANTHROPIC_API_KEY).toBe('');
    expect(settings).not.toHaveProperty('permissions'); expect(settings).not.toHaveProperty('hooks');
    if (process.platform !== 'win32') expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
  });
  test('simultaneous Codex sessions have separate providers and credentials, and independent cleanup', () => {
    const { root, input } = setup('codex-cli');
    const a = createTerminalSession(root, input);
    const b = createTerminalSession(root, { ...input, credential: 'second-token', model: { ...input.model, id: 'temporary-c' } });
    const first = claimTerminalSession(a.payloadPath).command; const second = claimTerminalSession(b.payloadPath).command;
    expect(first.env.CODING_ACCESS_SESSION_TOKEN).toBe('private-company-token'); expect(second.env.CODING_ACCESS_SESSION_TOKEN).toBe('second-token');
    expect(first.args.find(a => a.startsWith('model_provider='))).not.toBe(second.args.find(a => a.startsWith('model_provider=')));
    expect(first.args.join(' ')).not.toMatch(/private-company-token|experimental_bearer_token|approval_policy|sandbox_mode/);
    expect(first.args).toContain('model_context_window=128000');
    discardTerminalSession(a.directory); expect(existsSync(b.directory)).toBe(true);
  });
  test('a temporary launch does not require or create a default config', () => {
    const { root, manager, input } = setup();
    const session = createTerminalSession(root, input); claimTerminalSession(session.payloadPath);
    expect(existsSync(manager.path('claude-code'))).toBe(false); expect(manager.configured()).toEqual({});
  });
  test('a consumed session cannot launch twice or delete the first session files', () => {
    const { root, input } = setup();
    const session = createTerminalSession(root, input); const { command } = claimTerminalSession(session.payloadPath);
    expect(() => claimTerminalSession(session.payloadPath)).toThrow('已使用或已过期');
    expect(existsSync(command.args[1])).toBe(true);
  });
  test('invalid payloads clean their private files and cannot invoke a tool', () => {
    const { root, input } = setup(); const session = createTerminalSession(root, input);
    atomicWrite(session.payloadPath, '{ broken'); expect(() => claimTerminalSession(session.payloadPath)).toThrow();
    expect(existsSync(session.directory)).toBe(false);
    expect(() => createTerminalSession(root, { ...input, executable: 'bad\npath' })).toThrow('无效');
  });
  test('stale cleanup preserves active sessions, fresh unopened sessions and unrelated files', () => {
    const { root, input } = setup();
    const active = createTerminalSession(root, input); claimTerminalSession(active.payloadPath);
    const fresh = createTerminalSession(root, input); const expired = createTerminalSession(root, input);
    atomicWrite(join(expired.directory, 'owner.json'), JSON.stringify({ pid: null, createdAt: 0 }));
    const unrelated = join(root, 'terminal-sessions', 'user-file'); atomicWrite(unrelated, 'keep');
    cleanStaleTerminalSessions(root);
    expect(existsSync(active.directory)).toBe(true); expect(existsSync(fresh.payloadPath)).toBe(true);
    expect(existsSync(expired.directory)).toBe(false); expect(readFileSync(unrelated, 'utf8')).toBe('keep');
  });
  test('unknown capacity is not replaced with guessed values', () => {
    const { root, input } = setup('codex-cli');
    const session = createTerminalSession(root, { ...input, model: { ...input.model, contextWindow: undefined } });
    expect(claimTerminalSession(session.payloadPath).command.args.join(' ')).not.toContain('model_context_window');
  });
  test('a temporary Claude model with unknown capacity clears limits inherited from the saved default', () => {
    const { root, manager, input } = setup();
    manager.apply('claude-code', { ...input.model, id: 'large-default', contextWindow: 1000000 }, input.baseUrl, input.credential, 'cred');
    const original = readFileSync(manager.path('claude-code'));
    const session = createTerminalSession(root, { ...input, model: { ...input.model, contextWindow: undefined, maxOutputTokens: undefined } });
    const { command } = claimTerminalSession(session.payloadPath);
    const settings = JSON.parse(readFileSync(command.args[1], 'utf8'));
    for (const key of ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS']) {
      expect(command.env[key]).toBe(''); expect(settings.env[key]).toBe('');
    }
    expect(readFileSync(manager.path('claude-code'))).toEqual(original);
  });
  test('bundled runtime launch quotes arguments and restores its environment in the terminal', () => {
    const script = terminalScript('darwin', '/Apps/My App', "/work/O'Brien $literal", ['/runner.cjs', '/session $(x)`y`.json'], true);
    expect(script).toContain("ELECTRON_RUN_AS_NODE=1 '/Apps/My App' '/runner.cjs' '/session $(x)`y`.json'");
    expect(script).not.toContain('export ELECTRON_RUN_AS_NODE');
    const windows = terminalScript('win32', 'C:\\My App.exe', "C:\\O'Brien", ['C:\\runner.cjs', 'C:\\session.json'], true);
    expect(windows).toContain("Set-Location -LiteralPath 'C:\\O''Brien'");
    expect(windows).toContain("finally { [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $acaPreviousNodeMode, 'Process')");
    expect(() => terminalScript('darwin', '/app', '/project', ['bad\0argument'], true)).toThrow('控制字符');
  });
});
