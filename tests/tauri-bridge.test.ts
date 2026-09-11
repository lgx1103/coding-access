import { beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => native);
import { tauriBridge } from '../src/web/tauri-bridge';
beforeEach(() => { native.invoke.mockReset(); native.isTauri.mockReturnValue(true); });
it('leaves ordinary browser and Electron execution unchanged', () => { native.isTauri.mockReturnValue(false); expect(tauriBridge()).toBeUndefined(); });
it('launches the row model without invoking persistent apply', async () => {
  native.invoke.mockResolvedValue(null);
  await tauriBridge()!.launch('claude-code', 'temporary-model');
  expect(native.invoke).toHaveBeenCalledExactlyOnceWith('coding_access', { request: { action: 'launch', agent: 'claude-code', modelId: 'temporary-model' } });
});
it('normalizes native errors for the existing UI', async () => {
  native.invoke.mockRejectedValue('请登录公司账号');
  await expect(tauriBridge()!.request('/api/models')).rejects.toThrow('请登录公司账号');
});
