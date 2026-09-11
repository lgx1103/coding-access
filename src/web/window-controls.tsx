import { useEffect, useState } from 'react';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Button, Modal, Notice } from './components.js';

/** Mounted outside login and navigation so closing works on every screen. */
export function WindowControls() {
  const [prompt, setPrompt] = useState<{ trayAvailable: boolean } | null>(null);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!isTauri()) return;
    const subscription = listen<{ trayAvailable: boolean }>('aca-close-requested', event => {
      setPrompt(event.payload); setRemember(false); setError('');
    });
    return () => { void subscription.then(stop => stop()); };
  }, []);
  async function close(choice: 'cancel' | 'hide' | 'quit') {
    setBusy(true); setError('');
    try {
      await invoke('coding_access', { request: { action: 'closeWindow', choice, remember: choice !== 'cancel' && remember } });
      setPrompt(null);
      if (remember) { window.dispatchEvent(new CustomEvent('aca-close-preference-saved', { detail: choice })); window.dispatchEvent(new Event('aca-settings-saved')); }
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  if (!prompt) return null;
  return <Modal title="关闭 Coding Access" subtitle="选择关闭窗口后的行为。" onClose={() => { if (!busy) void close('cancel'); }} footer={<>
    <Button kind="quiet" disabled={busy} onClick={() => void close('cancel')}>取消</Button>
    <Button kind="secondary" disabled={busy} onClick={() => void close('quit')}>退出程序</Button>
    <Button disabled={busy || !prompt.trayAvailable} onClick={() => void close('hide')}>隐藏到托盘 / 菜单栏</Button>
  </>}>
    {error && <Notice error>{error}</Notice>}
    <p>隐藏后保持后台运行，可点击 Windows 托盘或 macOS 菜单栏中的图标重新打开。</p>
    <p>退出仅关闭 Coding Access，已打开的编程工具会继续运行。</p>
    {!prompt.trayAvailable && <Notice>托盘暂不可用，可以取消后使用窗口的最小化按钮。</Notice>}
    <label><input type="checkbox" checked={remember} disabled={busy} onChange={e => setRemember(e.target.checked)} /> 不再提醒，记住本次选择</label>
    <p className="small-note">之后可在「设置 → 启动与关闭」中修改。</p>
  </Modal>;
}
