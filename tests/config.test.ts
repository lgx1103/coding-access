import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';
import { parse } from 'jsonc-parser';
import { ConfigManager, atomicWrite } from '../src/desktop/config.js';
import { terminalScript } from '../src/desktop/launch.js';
import type { EmployeeModel } from '../src/shared/types.js';

const dirs: string[] = []; afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const model: EmployeeModel = { id: 'glm-test', name: 'GLM Test', description: '', contextWindow: 128000, maxOutputTokens: 8192, agents: ['claude-code', 'codex-cli', 'codex-desktop'], vision: false, status: 'available', updatedAt: Date.now() };
function setup() { const dir = mkdtempSync(join(tmpdir(), 'coding-access-config-')); dirs.push(dir); return new ConfigManager(join(dir, 'home'), join(dir, 'state'), {}); }
describe('isolated coding-agent configuration', () => {
  test('switching Claude models updates all four family aliases and their old display labels', () => {
    const manager = setup();
    const original = JSON.stringify({ env: {
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'deepseek-v4-flash', ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'DeepSeek',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'DeepSeek', ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'DeepSeek',
      ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: 'Old model description', ANTHROPIC_SMALL_FAST_MODEL: 'old-fast',
      API_TIMEOUT_MS: '3000000',
    }, enabledPlugins: { 'claude-hud@claude-hud': true }, statusLine: { type: 'command', command: 'my-hud' }, outputStyle: 'Concise' });
    atomicWrite(manager.path('claude-code'), original);
    manager.apply('claude-code', { ...model, id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1000000 }, 'https://company.test', 'company-token', 'cred');
    const content = parse(readFileSync(manager.path('claude-code'), 'utf8'));
    for (const family of ['HAIKU', 'SONNET', 'OPUS', 'FABLE']) {
      expect(content.env[`ANTHROPIC_DEFAULT_${family}_MODEL`]).toBe('glm-5.3-flash');
      expect(content.env[`ANTHROPIC_DEFAULT_${family}_MODEL_NAME`]).toBe('GLM-5.3-Flash');
      expect(content.env[`ANTHROPIC_DEFAULT_${family}_MODEL_DESCRIPTION`]).not.toMatch(/DeepSeek|Old model/);
    }
    expect(content.env.ANTHROPIC_SMALL_FAST_MODEL).toBe('glm-5.3-flash');
    expect(content.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000');
    expect(content.env).not.toHaveProperty('DISABLE_COMPACT');
    expect(content.statusLine).toEqual({ type: 'command', command: 'my-hud' });
    expect(content.enabledPlugins).toEqual({ 'claude-hud@claude-hud': true });
    expect(content.env.API_TIMEOUT_MS).toBe('3000000'); expect(content.outputStyle).toBe('Concise');
    manager.restore('claude-code'); expect(readFileSync(manager.path('claude-code'), 'utf8')).toBe(original);
  });
  test('Claude context follows the exact model capacity and clears managed limits when capacity is unknown', () => {
    const manager = setup();
    for (const contextWindow of [1000000, 128000, 1024000, undefined]) {
      manager.apply('claude-code', { ...model, contextWindow }, 'https://company.test', 'company-token', 'cred');
      const content = parse(readFileSync(manager.path('claude-code'), 'utf8'));
      expect(content.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(contextWindow?.toString());
      expect(content.model).toBe(model.id); expect(content.env.ANTHROPIC_MODEL).toBe(model.id);
      expect(manager.records()['claude-code'].managedCapabilities?.includes('contextWindow')).toBe(contextWindow !== undefined);
    }
  });
  test('old Claude takeover records request one sync without changing files or preventing restoration', () => {
    const manager = setup(); const original = '{"model":"personal"}'; atomicWrite(manager.path('claude-code'), original);
    manager.apply('claude-code', model, 'https://company.test', 'company-token', 'cred');
    const records = manager.records(); delete records['claude-code'].claudeConfigRevision;
    atomicWrite(join(manager.stateDirectory, 'config-records.json'), JSON.stringify(records));
    const before = readFileSync(manager.path('claude-code'));
    expect(manager.isApplied('claude-code', model.id)).toBe(false);
    expect(manager.warnings('claude-code').join(' ')).toContain('同步');
    expect(readFileSync(manager.path('claude-code'))).toEqual(before);
    manager.apply('claude-code', model, 'https://company.test', 'company-token', 'cred');
    expect(manager.isApplied('claude-code', model.id)).toBe(true);
    expect(manager.records()['claude-code'].backup).toBe(records['claude-code'].backup);
    manager.restore('claude-code'); expect(readFileSync(manager.path('claude-code'), 'utf8')).toBe(original);
  });
  test('default model matching includes the shared Codex configuration used by desktop launch', () => {
    const manager = setup();
    for (const agent of ['claude-code', 'codex-cli', 'codex-desktop', 'zcode'] as const) {
      expect(() => manager.assertApplied(agent, model.id)).toThrow('尚未应用');
    }
    manager.apply('claude-code', model, 'https://company.test', 'company-token', 'cred');
    expect(manager.isApplied('claude-code', model.id)).toBe(true);
    expect(() => manager.assertApplied('claude-code', 'next-model')).toThrow('尚未应用');
    manager.apply('claude-code', { ...model, id: 'next-model' }, 'https://company.test', 'company-token', 'cred');
    expect(() => manager.assertApplied('claude-code', model.id)).toThrow('尚未应用');
    expect(manager.isApplied('claude-code', 'next-model')).toBe(true);
    manager.apply('codex-cli', model, 'https://company.test', 'company-token', 'cred');
    expect(manager.isApplied('codex-desktop', model.id)).toBe(true);
    manager.apply('codex-desktop', { ...model, id: 'next-model' }, 'https://company.test', 'company-token', 'cred');
    expect(manager.isApplied('codex-cli', model.id)).toBe(false);
    expect(manager.isApplied('codex-cli', 'next-model')).toBe(true);
  });
  test('external model changes or restoration invalidate the applied state before launch', () => {
    const manager = setup();
    manager.apply('claude-code', model, 'https://company.test', 'company-token', 'cred');
    atomicWrite(manager.path('claude-code'), '{"env":{"ANTHROPIC_MODEL":"external"}}');
    expect(manager.isApplied('claude-code', model.id)).toBe(false);
    expect(() => manager.assertApplied('claude-code', model.id)).toThrow('本地配置已发生变化');
    expect(readFileSync(manager.path('claude-code'), 'utf8')).toContain('external');
    manager.apply('zcode', model, 'https://company.test', 'company-token', 'cred');
    expect(manager.isApplied('zcode', model.id)).toBe(true);
    manager.restore('zcode');
    expect(manager.isApplied('zcode', model.id)).toBe(false);
    expect(() => manager.assertApplied('zcode', model.id)).toThrow('尚未应用');
  });
  test('unknown model capacity leaves tool limits unset in a new configuration', () => {
    const manager = setup(); const unknown = { ...model, contextWindow: undefined, maxOutputTokens: undefined, vision: undefined };
    manager.apply('claude-code', unknown, 'https://company.test', 'company-token', 'cred');
    const claude = parse(readFileSync(manager.path('claude-code'), 'utf8'));
    expect(claude.env).not.toHaveProperty('CLAUDE_CODE_MAX_OUTPUT_TOKENS');
    expect(claude.env).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS');
    manager.apply('codex-cli', unknown, 'https://company.test', 'company-token', 'cred');
    const codex = TOML.parse(readFileSync(manager.path('codex-cli'), 'utf8'));
    expect(codex).not.toHaveProperty('model_context_window'); expect(codex).not.toHaveProperty('model_auto_compact_token_limit');
    expect(readFileSync(manager.path('codex-cli'), 'utf8')).not.toMatch(/NaN|undefined/);
  });
  test('switching to an unknown-capacity model removes managed limits and restores the original files exactly', () => {
    const manager = setup(); const unknown = { ...model, id: 'custom', contextWindow: undefined, maxOutputTokens: undefined };
    const originals = {
      'claude-code': '{\n // Original preferences\n "env": { "CUSTOM": "keep", "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "2048" }\n}\n',
      'codex-cli': '# Original preferences\nmodel_context_window = 32000\nmodel_auto_compact_token_limit = 24000\n[projects."/work"]\ntrust_level = "trusted"\n',
    };
    for (const agent of ['claude-code', 'codex-cli'] as const) {
      atomicWrite(manager.path(agent), originals[agent]);
      manager.apply(agent, model, 'https://company.test', 'company-token', 'cred');
      manager.apply(agent, unknown, 'https://company.test', 'company-token', 'cred');
      const source = readFileSync(manager.path(agent), 'utf8');
      if (agent === 'claude-code') {
        const config = parse(source); expect(config.env).not.toHaveProperty('CLAUDE_CODE_MAX_OUTPUT_TOKENS'); expect(config.env.CUSTOM).toBe('keep');
      } else {
        const config = TOML.parse(source); expect(config).not.toHaveProperty('model_context_window'); expect(config).not.toHaveProperty('model_auto_compact_token_limit');
      }
      manager.restore(agent); expect(readFileSync(manager.path(agent), 'utf8')).toBe(originals[agent]);
    }
  });
  test('unknown models preserve personal limits that this client did not manage, including repeated applications', () => {
    const manager = setup(); const unknown = { ...model, contextWindow: undefined, maxOutputTokens: undefined };
    atomicWrite(manager.path('claude-code'), '{"env":{"CLAUDE_CODE_MAX_OUTPUT_TOKENS":"2048","CLAUDE_CODE_MAX_CONTEXT_TOKENS":"32000"}}');
    atomicWrite(manager.path('codex-cli'), 'model_context_window = 32000\nmodel_auto_compact_token_limit = 24000\n');
    for (let i = 0; i < 2; i++) {
      manager.apply('claude-code', unknown, 'https://company.test', 'company-token', 'cred');
      manager.apply('codex-cli', unknown, 'https://company.test', 'company-token', 'cred');
    }
    expect(parse(readFileSync(manager.path('claude-code'), 'utf8')).env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('2048');
    expect(parse(readFileSync(manager.path('claude-code'), 'utf8')).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('32000');
    expect(TOML.parse(readFileSync(manager.path('codex-cli'), 'utf8')).model_context_window).toBe(32000);
  });
  test('legacy takeover records clear their old capacity assumptions when selecting an unknown model', () => {
    const manager = setup(); const unknown = { ...model, contextWindow: undefined, maxOutputTokens: undefined };
    for (const agent of ['claude-code', 'codex-cli'] as const) manager.apply(agent, model, 'https://company.test', 'company-token', 'cred');
    const records = manager.records(); for (const record of Object.values(records)) delete record.managedCapabilities;
    atomicWrite(join(manager.stateDirectory, 'config-records.json'), JSON.stringify(records));
    for (const agent of ['claude-code', 'codex-cli'] as const) manager.apply(agent, unknown, 'https://company.test', 'company-token', 'cred');
    expect(parse(readFileSync(manager.path('claude-code'), 'utf8')).env).not.toHaveProperty('CLAUDE_CODE_MAX_OUTPUT_TOKENS');
    expect(TOML.parse(readFileSync(manager.path('codex-cli'), 'utf8'))).not.toHaveProperty('model_context_window');
    expect(TOML.parse(readFileSync(manager.path('codex-cli'), 'utf8'))).not.toHaveProperty('model_auto_compact_token_limit');
  });
  test('legacy Claude records do not claim a context override that the old client never wrote', () => {
    const manager = setup(); const unknown = { ...model, contextWindow: undefined, maxOutputTokens: undefined };
    atomicWrite(manager.path('claude-code'), '{"env":{"CLAUDE_CODE_MAX_CONTEXT_TOKENS":"64000"}}');
    manager.apply('claude-code', unknown, 'https://company.test', 'company-token', 'cred');
    const records = manager.records(); delete records['claude-code'].managedCapabilities; delete records['claude-code'].claudeConfigRevision;
    atomicWrite(join(manager.stateDirectory, 'config-records.json'), JSON.stringify(records));
    manager.apply('claude-code', unknown, 'https://company.test', 'company-token', 'cred');
    expect(parse(readFileSync(manager.path('claude-code'), 'utf8')).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('64000');
  });
  test('Claude merge preserves comments, permissions and custom env; restore is byte exact', () => {
    const manager = setup(); const path = manager.path('claude-code');
    const original = '{\n // my note\n "permissions": {"allow": ["Read"]}, "env": {"CUSTOM": "keep", "ANTHROPIC_API_KEY": "old-key"}\n}\n'; atomicWrite(path, original);
    manager.apply('claude-code', model, 'https://company.test', 'company-token', 'cred');
    const text = readFileSync(path, 'utf8'); const content = parse(text);
    expect(text).toContain('// my note'); expect(content.permissions.allow).toEqual(['Read']); expect(content.env.CUSTOM).toBe('keep');
    expect(content.env.ANTHROPIC_AUTH_TOKEN).toBe('company-token'); expect(content.env.ANTHROPIC_API_KEY).toBe('');
    manager.restore('claude-code'); expect(readFileSync(path, 'utf8')).toBe(original);
  });
  test('Codex CLI and desktop share config, preserve projects, use Responses and restore original text', () => {
    const manager = setup(); const path = manager.path('codex-cli'); const original = '# my comment\nmodel = "old"\n[projects."/work"]\ntrust_level = "trusted"\n'; atomicWrite(path, original);
    manager.apply('codex-desktop', model, 'https://company.test', 'company-token', 'cred');
    const parsed: any = TOML.parse(readFileSync(path, 'utf8')); expect(parsed.projects['/work'].trust_level).toBe('trusted');
    expect(parsed.model_providers.coding_access.wire_api).toBe('responses'); expect(parsed.model_providers.coding_access.experimental_bearer_token).toBe('company-token');
    expect(parsed.features.enable_request_compression).toBe(false); expect(manager.configured()['codex-cli']).toEqual(manager.configured()['codex-desktop']);
    manager.restore('codex-cli'); expect(readFileSync(path, 'utf8')).toBe(original); expect(manager.configured()).toEqual({});
  });
  test('changing model retains the original takeover backup', () => {
    const manager = setup(); atomicWrite(manager.path('codex-cli'), 'model="personal"\n');
    manager.apply('codex-cli', model, 'https://company.test', 'company-token', 'cred'); manager.apply('codex-cli', { ...model, id: 'glm-next' }, 'https://company.test', 'company-token', 'cred');
    expect(TOML.parse(readFileSync(manager.path('codex-cli'), 'utf8')).model).toBe('glm-next');
    manager.restore('codex-cli'); expect(readFileSync(manager.path('codex-cli'), 'utf8')).toBe('model="personal"\n');
  });
  test('restore removes a config created by the client without deleting its directory', () => {
    const manager = setup(); manager.apply('claude-code', model, 'https://company.test', 'company-token', 'cred'); manager.restore('claude-code');
    expect(existsSync(manager.path('claude-code'))).toBe(false); expect(existsSync(join(manager.home, '.claude'))).toBe(true);
  });
  test('external changes prevent clobbering by apply or restore', () => {
    const manager = setup(); manager.apply('claude-code', model, 'https://company.test', 'company-token', 'cred'); atomicWrite(manager.path('claude-code'), '{"custom":"external"}');
    expect(() => manager.restore('claude-code')).toThrow('其他程序'); expect(() => manager.apply('claude-code', model, 'https://company.test', 'company-token', 'cred')).toThrow('其他程序');
    expect(readFileSync(manager.path('claude-code'), 'utf8')).toContain('external');
  });
  test('malformed existing config is untouched', () => {
    const manager = setup(); atomicWrite(manager.path('claude-code'), '{ nope');
    expect(() => manager.apply('claude-code', model, 'https://company.test', 'token', 'cred')).toThrow('格式无效'); expect(readFileSync(manager.path('claude-code'), 'utf8')).toBe('{ nope');
  });
  test('custom config home is honored through injected environment', () => {
    const manager = setup(); const custom = new ConfigManager(manager.home, manager.stateDirectory, { CODEX_HOME: join(manager.home, 'custom-codex'), CLAUDE_CONFIG_DIR: join(manager.home, 'custom-claude') });
    expect(custom.path('codex-cli')).toBe(join(manager.home, 'custom-codex/config.toml')); expect(custom.path('claude-code')).toBe(join(manager.home, 'custom-claude/settings.json'));
  });
  test('terminal scripts quote spaces, apostrophes, backticks and dollar expansions literally', () => {
    expect(terminalScript('darwin', '/bin/a b', "/work/a'$(touch bad)`evil`" )).toContain("'/work/a'\\''$(touch bad)`evil`'");
    expect(terminalScript('win32', 'C:\\Tool Box\\codex.cmd', "C:\\Project O'Brien;$evil")).toBe("Set-Location -LiteralPath 'C:\\Project O''Brien;$evil'; & 'C:\\Tool Box\\codex.cmd'");
    expect(() => terminalScript('win32', 'codex', 'bad\npath')).toThrow('控制字符');
  });
});
