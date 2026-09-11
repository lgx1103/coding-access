export const AGENT_IDS = ['claude-code', 'codex-cli', 'codex-desktop', 'zcode'] as const;
export type AgentId = typeof AGENT_IDS[number];
export type Protocol = 'messages' | 'chat' | 'responses';
export const isCodexAgent = (agent: string) => agent === 'codex-cli' || agent === 'codex-desktop';
export const isDesktopAgent = (agent: AgentId) => agent === 'codex-desktop' || agent === 'zcode';
export const agentProtocol = (agent?: string): Protocol => agent === 'claude-code' || agent === 'zcode' ? 'messages' : 'responses';
export const matchesAgent = (recorded: string | undefined, agent: AgentId) => recorded === agent || (isCodexAgent(agent) && recorded === 'codex');
export type Role = 'admin' | 'employee';
export interface PublicUser { id: string; username: string; name: string; role: Role; enabled: boolean; mustChangePassword: boolean; models: string[]; createdAt: number }
export interface Provider {
  id: string; name: string; product: string; enabled: boolean;
  endpoints: Partial<Record<Protocol, string>>;
  auth: 'bearer' | 'x-api-key'; headers: Record<string, string>;
  defaults: Record<string, unknown>;
  createdAt: number;
}
export interface ModelRoute { providerId: string; upstreamModel: string; weight: number; vision?: boolean; contextWindow?: number }
export type ModelAudience = { type: 'all' } | { type: 'selected'; userIds: string[] };
export interface Model {
  id: string; name: string; description: string; enabled: boolean;
  agents: AgentId[]; contextWindow?: number; maxOutputTokens?: number; vision?: boolean;
  routes: ModelRoute[]; capabilityMode?: 'automatic' | 'manual' | 'unified'; createdAt: number;
  audience?: ModelAudience; everPublished?: boolean;
}
export interface EmployeeModel {
  id: string; name: string; description: string; agents: AgentId[];
  brand?: import('./brand.js').ModelBrand;
  contextWindow?: number; maxOutputTokens?: number; vision?: boolean;
  status: 'available' | 'busy' | 'unavailable' | 'unknown'; updatedAt: number;
}
export interface ApiKey {
  id: string; providerId: string; name: string; enabled: boolean;
  secretHash: string; encryptedSecret: string; hint: string;
  models: string[]; maxConcurrent: number; weight: number;
  rateScope: 'key' | 'model' | 'group'; group: string;
  createdAt: number;
}
export interface Usage { input: number | null; output: number | null; cached: number | null }
export interface KeyState { scope: string; until: number; reason: string; updatedAt: number }
export const AGENTS: { id: AgentId; name: string; description: string }[] = [
  { id: 'claude-code', name: 'Claude Code', description: '在终端中编程' },
  { id: 'codex-cli', name: 'Codex CLI', description: '在终端中编程' },
  { id: 'codex-desktop', name: 'Codex 桌面版', description: '在桌面应用中编程' },
  { id: 'zcode', name: 'ZCode', description: '使用智谱 ZCode 桌面应用' },
];
