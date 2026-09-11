import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import TOML from '@iarna/toml';
import type { AgentId, EmployeeModel } from '../shared/types.js';
import { isCodexAgent } from '../shared/types.js';

type ManagedCapability = 'contextWindow' | 'maxOutputTokens';
export interface ConfigRecord { modelId: string; modelName: string; appliedAt: number; path: string; credentialId: string; hash: string; backup: string | null; originalExists: boolean; managedCapabilities?: ManagedCapability[]; claudeConfigRevision?: number; zcodeProviderHash?: string; preserveZcodeExternalChanges?: boolean }
const claudeConfigRevision = 1;
export function atomicWrite(path: string, value: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('配置文件是符号链接，请先将配置迁移为普通文件');
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try { writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); if (process.platform !== 'win32') chmodSync(path, 0o600); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export const fileHash = (value: string) => createHash('sha256').update(value).digest('hex');
function jsonObject(source: string, tool = 'Claude Code') {
  const errors: ParseError[] = []; const parsed = parse(source || '{}', errors, { allowTrailingComma: true });
  if (errors.length || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`现有 ${tool} 配置格式无效，请先修复 JSON 配置`);
  return parsed as Record<string, any>;
}
export function claudeConfiguration(source: string, base: string, credential: string, model: EmployeeModel, managedCapabilities: readonly ManagedCapability[] = []) {
  const parsed = jsonObject(source); if (parsed.env != null && (typeof parsed.env !== 'object' || Array.isArray(parsed.env))) throw new Error('Claude Code 配置的 env 必须是对象');
  const fields: Record<string, string | undefined> = { ANTHROPIC_BASE_URL: base.replace(/\/$/, ''), ANTHROPIC_AUTH_TOKEN: credential, ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: model.id,
    CLAUDE_CODE_SUBAGENT_MODEL: model.id, CLAUDE_CODE_MAX_RETRIES: '0' };
  for (const family of ['HAIKU', 'SONNET', 'OPUS', 'FABLE']) {
    const key = `ANTHROPIC_DEFAULT_${family}_MODEL`;
    fields[key] = model.id;
    fields[`${key}_NAME`] = model.name;
    fields[`${key}_DESCRIPTION`] = model.description || `通过 Coding Access 使用 ${model.name}`;
  }
  if (parsed.env?.ANTHROPIC_SMALL_FAST_MODEL !== undefined) fields.ANTHROPIC_SMALL_FAST_MODEL = model.id;
  // Custom gateway IDs accept an exact window without changing the routing ID
  // or disabling compaction. A [1m] suffix would incorrectly round other sizes.
  if (model.contextWindow !== undefined) fields.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(model.contextWindow);
  else if (managedCapabilities.includes('contextWindow')) fields.CLAUDE_CODE_MAX_CONTEXT_TOKENS = undefined;
  if (model.maxOutputTokens !== undefined) fields.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(model.maxOutputTokens);
  else if (managedCapabilities.includes('maxOutputTokens')) fields.CLAUDE_CODE_MAX_OUTPUT_TOKENS = undefined;
  let result = source || '{}\n';
  for (const [key, value] of [...Object.entries(fields).map(([k, v]) => [['env', k], v] as const), [['model'], model.id] as const]) result = applyEdits(result, modify(result, [...key], value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }));
  return result.endsWith('\n') ? result : `${result}\n`;
}
export function codexConfiguration(source: string, base: string, credential: string, model: EmployeeModel, managedCapabilities: readonly ManagedCapability[] = []) {
  let settings: any; try { settings = TOML.parse(source); } catch { throw new Error('现有 Codex 配置格式无效，请先修复 TOML 配置'); }
  settings.model = model.id; settings.model_provider = 'coding_access';
  if (model.contextWindow !== undefined) {
    settings.model_context_window = model.contextWindow;
    settings.model_auto_compact_token_limit = Math.max(1024, Math.floor(model.contextWindow * .8));
  } else if (managedCapabilities.includes('contextWindow')) {
    delete settings.model_context_window;
    delete settings.model_auto_compact_token_limit;
  }
  settings.web_search = 'disabled';
  settings.features = { ...(settings.features ?? {}), enable_request_compression: false, respect_system_proxy: true };
  settings.model_providers = { ...(settings.model_providers ?? {}), coding_access: { name: 'Coding Access', base_url: `${base.replace(/\/$/, '')}/v1`, wire_api: 'responses', experimental_bearer_token: credential, requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0 } };
  return TOML.stringify(settings);
}

export function zcodeConfiguration(source: string, base: string, credential: string, model: EmployeeModel) {
  const parsed = jsonObject(source, 'ZCode');
  if (parsed.provider != null && (typeof parsed.provider !== 'object' || Array.isArray(parsed.provider))) throw new Error('ZCode 配置的 provider 必须是对象');
  const previous = parsed.provider?.coding_access ?? {};
  const previousModel = previous.models?.[model.id] ?? {};
  const limit = { ...(model.contextWindow !== undefined ? { context: model.contextWindow } : {}), ...(model.maxOutputTokens !== undefined ? { output: model.maxOutputTokens } : {}) };
  const entry = {
    ...previousModel,
    name: model.name,
    limit: undefined,
    modalities: undefined,
    zcode: { ...previousModel.zcode, modalitiesConfigured: undefined },
    ...(Object.keys(limit).length ? { limit } : {}),
    ...(model.vision === undefined ? {} : { modalities: { input: model.vision ? ['text', 'image'] : ['text'], output: ['text'] }, zcode: { ...previousModel.zcode, modalitiesConfigured: true } }),
  };
  const provider = { ...previous, name: 'Coding Access', kind: 'anthropic', enabled: true,
    options: { ...previous.options, apiKey: credential, baseURL: base.replace(/\/$/, ''), apiKeyRequired: true },
    headers: { ...previous.headers, 'x-coding-agent': 'zcode' }, models: { [model.id]: entry } };
  // The desktop persists model selection per workspace/session. Do not overwrite
  // those stores or invent a default-model field in its provider configuration.
  const result = applyEdits(source || '{}\n', modify(source || '{}\n', ['provider', 'coding_access'], provider, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }));
  return result.endsWith('\n') ? result : `${result}\n`;
}

function zcodeProviderHash(source: string) {
  const provider = jsonObject(source, 'ZCode').provider?.coding_access ?? null;
  // ZCode adds source and reasoning metadata on startup. Reasoning remains
  // owned by ZCode and is retained when reapplying the same model.
  if (provider?.source === 'custom') delete provider.source;
  for (const model of Object.values(provider?.models ?? {}) as any[]) if (model && typeof model === 'object') delete model.reasoning;
  const ordered = (value: any): any => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  return fileHash(JSON.stringify(ordered(provider)));
}

/** The only module that edits agent files. Tests inject an isolated home directory. */
export class ConfigManager {
  private recordsPath: string;
  constructor(readonly home: string, readonly stateDirectory: string, readonly env: NodeJS.ProcessEnv = process.env) { this.recordsPath = join(stateDirectory, 'config-records.json'); }
  key(agent: AgentId) { return isCodexAgent(agent) ? 'codex' : agent; }
  path(agent: AgentId) {
    if (agent === 'zcode') {
      const custom = this.env.ZCODE_DATA_BASE_DIR;
      return join(custom ? isAbsolute(custom) ? custom : resolve(this.home, custom) : this.home, '.zcode/v2/config.json');
    }
    const custom = agent === 'claude-code' ? this.env.CLAUDE_CONFIG_DIR : this.env.CODEX_HOME;
    const directory = custom ? isAbsolute(custom) ? custom : resolve(this.home, custom) : join(this.home, agent === 'claude-code' ? '.claude' : '.codex');
    return join(directory, agent === 'claude-code' ? 'settings.json' : 'config.toml');
  }
  records(): Record<string, ConfigRecord> { if (!existsSync(this.recordsPath)) return {}; return JSON.parse(readFileSync(this.recordsPath, 'utf8')); }
  configured() { const r = this.records(); return { ...(r['claude-code'] ? { 'claude-code': r['claude-code'] } : {}), ...(r.codex ? { 'codex-cli': r.codex, 'codex-desktop': r.codex } : {}), ...(r.zcode ? { zcode: r.zcode } : {}) }; }
  isApplied(agent: AgentId, modelId: string) {
    try { this.assertApplied(agent, modelId); return true; } catch { return false; }
  }
  assertApplied(agent: AgentId, modelId: string) {
    const record = this.records()[this.key(agent)];
    if (!record || record.modelId !== modelId) throw new Error('所选模型尚未应用，请先应用所选模型再打开工具');
    if (!this.matches(agent, record, this.source(agent))) throw new Error('本地配置已发生变化，请先检查配置，再打开工具');
    if (agent === 'claude-code' && record.claudeConfigRevision !== claudeConfigRevision) throw new Error('请同步一次 Claude Code 默认配置，补齐模型别名和上下文长度');
  }
  private source(agent: AgentId) { const p = this.path(agent); if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('配置文件为符号链接，暂不支持自动写入'); return existsSync(p) ? readFileSync(p, 'utf8') : ''; }
  private matches(agent: AgentId, record: ConfigRecord, source: string) {
    return record.path === this.path(agent) && (record.hash === fileHash(source) || (agent === 'zcode' && Boolean(record.zcodeProviderHash) && record.zcodeProviderHash === zcodeProviderHash(source)));
  }
  warnings(agent: AgentId, project = '') {
    const warnings: string[] = []; const records = this.records(); const current = records[this.key(agent)];
    if (current && !this.matches(agent, current, this.source(agent))) warnings.push('配置在应用后发生过外部修改，自动恢复和再次写入已暂停。请先手动检查配置文件。');
    if (agent === 'claude-code') {
      if (current && current.claudeConfigRevision !== claudeConfigRevision) warnings.push('客户端已更新 Claude Code 配置规则，请在默认模型一行点击“同步”，补齐模型别名和上下文长度。');
      const parsed = jsonObject(this.source(agent));
      if (parsed.apiKeyHelper || parsed.env?.ANTHROPIC_CUSTOM_HEADERS) warnings.push('现有配置包含自定义鉴权，请在 Claude Code 中检查最终生效的连接设置。');
      if (project && ['settings.json', 'settings.local.json'].some(file => existsSync(join(project, '.claude', file)))) warnings.push('项目含 Claude Code 配置，可能覆盖用户级设置；请在新会话中检查实际模型。');
      if (this.env.CLAUDE_CODE_USE_BEDROCK || this.env.CLAUDE_CODE_USE_VERTEX || this.env.CLAUDE_CODE_USE_FOUNDRY) warnings.push('当前进程存在云平台路由变量，可能覆盖公司网关设置。');
    } else if (agent === 'zcode') {
      jsonObject(this.source(agent), 'ZCode');
      warnings.push('请先完全退出 ZCode 再应用或恢复配置。重新打开后，在模型选择器中选择 Coding Access 下的模型；已有会话不会自动切换。');
      if (project && ['zcode.json', 'zcode.jsonc', '.zcode/config.json'].some(file => existsSync(join(project, file)))) warnings.push('项目含 ZCode 配置，请在新会话中确认实际使用的是 Coding Access 模型。');
    } else {
      warnings.push('Codex CLI 与 Codex 桌面版共用这份配置。请新建 CLI 会话，并完全退出后重新打开 Codex 桌面版。');
      if (project && existsSync(join(project, '.codex', 'config.toml'))) warnings.push('项目含 Codex 配置，可能覆盖用户级设置。');
      if (this.source(agent)) { const config: any = TOML.parse(this.source(agent)); if (config.profile) warnings.push('Codex 启用了配置 profile，请检查该 profile 是否覆盖模型或接入。'); }
    }
    return warnings;
  }
  apply(agent: AgentId, model: EmployeeModel, base: string, credential: string, credentialId: string) {
    const path = this.path(agent); const source = this.source(agent); const records = this.records(); const current = records[this.key(agent)];
    if (current && !this.matches(agent, current, source)) throw new Error('配置在上次应用后被其他程序修改。为保留这些改动，请先手动检查配置并处理本地接管记录。');
    // Older Claude records only managed output limits; a personal context
    // override in those files must not be mistaken for one we wrote.
    const previousCapabilities: readonly ManagedCapability[] = current ? current.managedCapabilities ?? (agent === 'claude-code' ? ['maxOutputTokens'] : ['contextWindow', 'maxOutputTokens']) : [];
    const next = agent === 'claude-code' ? claudeConfiguration(source, base, credential, model, previousCapabilities) : agent === 'zcode' ? zcodeConfiguration(source, base, credential, model) : codexConfiguration(source, base, credential, model, previousCapabilities);
    let backup = current?.backup ?? null; const originalExists = current?.originalExists ?? existsSync(path);
    if (!current && originalExists) { backup = join(this.stateDirectory, 'backups', `${this.key(agent)}-${Date.now()}.backup`); atomicWrite(backup, source); }
    atomicWrite(path, next);
    const managedCapabilities: ManagedCapability[] = agent === 'zcode' ? [] : [
      ...(model.contextWindow === undefined ? [] : ['contextWindow' as const]),
      ...(agent === 'claude-code' && model.maxOutputTokens !== undefined ? ['maxOutputTokens' as const] : []),
    ];
    records[this.key(agent)] = { modelId: model.id, modelName: model.name, appliedAt: Date.now(), path, credentialId, hash: fileHash(next), backup, originalExists, managedCapabilities,
      ...(agent === 'claude-code' ? { claudeConfigRevision } : {}),
      ...(agent === 'zcode' ? { zcodeProviderHash: zcodeProviderHash(next), preserveZcodeExternalChanges: Boolean(current?.preserveZcodeExternalChanges || (current && current.hash !== fileHash(source))) } : {}) };
    atomicWrite(this.recordsPath, JSON.stringify(records, null, 2));
    return { path, warnings: this.warnings(agent) };
  }
  restore(agent: AgentId) {
    const records = this.records(); const record = records[this.key(agent)]; if (!record) throw new Error('没有可恢复的客户端备份');
    const source = this.source(agent);
    if (!this.matches(agent, record, source)) throw new Error('配置已被其他程序修改，为避免覆盖你的修改，请手动恢复备份');
    if (record.originalExists && (!record.backup || !existsSync(record.backup))) throw new Error('接管前的配置备份不存在');
    if (agent === 'zcode' && (record.preserveZcodeExternalChanges || record.hash !== fileHash(source))) {
      const original = record.backup ? jsonObject(readFileSync(record.backup, 'utf8'), 'ZCode').provider?.coding_access : undefined;
      // Restore only our provider if ZCode or the user added other settings.
      const next = applyEdits(source, modify(source, ['provider', 'coding_access'], original, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }));
      atomicWrite(record.path, next);
    }
    else if (record.originalExists) atomicWrite(record.path, readFileSync(record.backup!));
    else unlinkSync(record.path);
    delete records[this.key(agent)]; atomicWrite(this.recordsPath, JSON.stringify(records, null, 2)); return { path: record.path };
  }
}
