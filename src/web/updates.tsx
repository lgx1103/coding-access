import { useCallback, useEffect, useRef, useState } from 'react';
import { api, copyText, desktop } from './api.js';
import { Help } from './help.js';
import { Button, Notice, Modal } from './components.js';

export function useUpdates(userId?: string) {
  const cacheKey = useRef('');
  const [preferencesRevision, setPreferencesRevision] = useState(0);
  useEffect(() => { const changed = () => setPreferencesRevision(v => v + 1); window.addEventListener('aca-settings-saved', changed); return () => window.removeEventListener('aca-settings-saved', changed); }, []);
  const [update, setUpdate] = useState<any>({ state: 'idle' });
  const requestSerial = useRef(0);
  const appliedSerial = useRef(0);
  const action = useCallback(async (operation: string) => {
    if (!desktop?.update) return;
    const serial = ++requestSerial.current;
    if (operation === 'downloadAndInstall') setUpdate((old: any) => ({ ...old, state: 'downloading', downloaded: 0, autoInstall: true, message: undefined }));
    if (operation === 'check') setUpdate((old: any) => ({ ...old, state: 'checking', message: undefined }));
    try { const value = await desktop.update(operation); if (serial < appliedSerial.current) return; appliedSerial.current = serial; setUpdate((old: any) => {
      const next = value.state === 'checking' || value.state === 'error' ? { ...old, ...value } : value;
      if (cacheKey.current && typeof next.available === 'boolean') try { localStorage.setItem(cacheKey.current, JSON.stringify({ available: next.available, latest: next.latest, notes: next.notes, checkedAt: next.checkedAt })); } catch {}
      return next;
    }); }
    catch (error) { if (serial < appliedSerial.current) return; appliedSerial.current = serial; setUpdate((s: any) => ({ ...s, state: 'error', message: (error as Error).message })); }
  }, []);
  useEffect(() => {
    let active = true;
    cacheKey.current = '';
    appliedSerial.current = ++requestSerial.current;
    setUpdate({ state: 'idle' });
    if (userId && desktop?.getSettings && desktop.update) void desktop.getSettings().then(async s => {
      const state = await desktop!.getState();
      if (!active) return;
      cacheKey.current = `aca-update:${s.preferences.serverUrl}:${s.preferences.updateChannel}:${state.version}`;
      try { const cached = JSON.parse(localStorage.getItem(cacheKey.current) ?? 'null'); if (active && cached && typeof cached.available === 'boolean') setUpdate({ ...cached, state: 'idle' }); } catch {}
      if (active && s.preferences.checkUpdates) await action('check');
    }).catch(() => {});
    return () => { active = false; };
  }, [userId, action, preferencesRevision]);
  useEffect(() => {
    if (!(['checking', 'downloading', 'installing'].includes(update.state) || (update.state === 'ready' && update.autoInstall))) return;
    const timer = setInterval(() => void action('status'), 250);
    return () => clearInterval(timer);
  }, [update.state, update.autoInstall, action]);
  return { update, action };
}
export function UpdatesPanel({ version, update, action }: { version: string; update: any; action: (operation: string) => Promise<void> }) {
  const busy = (['checking', 'downloading', 'installing'].includes(update.state) || (update.state === 'ready' && update.autoInstall));
  const labels: Record<string, string> = { idle: '尚未检查更新', checking: '正在检查新版本…', current: '已是当前通道的最新版本', unpublished: '管理员尚未发布此平台的版本', available: '有新版本可用', downloading: '正在下载并校验更新', ready: '更新包已校验，可安装', installing: '正在安装更新…', manual: '更新文件尚未发布完整', incompatible: '有新版本，请先升级公司服务端', error: '更新未完成' };
  const finished = ['ready', 'installing'].includes(update.state);
  const percent = finished ? 100 : update.total ? Math.min(100, Math.floor((update.downloaded ?? 0) / update.total * 100)) : undefined;
  return <section className="update-panel"><div className="page-heading"><div><h1>更新与关于</h1><p>Coding Access · 当前版本 {version}</p></div><Button kind="secondary" disabled={busy || update.state === 'ready'} onClick={() => void action('check')}>检查更新</Button></div>
    <h2>{update.state === 'ready' && update.autoInstall ? '校验通过，即将自动安装并重启…' : labels[update.state] ?? '检查更新'}</h2>{update.latest && <p>{version} → <strong>{update.latest}</strong></p>}
    {update.checkedAt && <p className="small-note">上次检查：{new Date(update.checkedAt).toLocaleString('zh-CN')}</p>}
    {update.message && <Notice error={update.state === 'error'}>{update.message}</Notice>}
    {update.state === 'incompatible' && <Notice>需要服务端 {update.minServerVersion} 或更高版本，请联系管理员升级。</Notice>}

    {(update.state === 'downloading' || finished) && <div className="update-progress" role="status" aria-live="polite"><progress aria-label="更新下载进度" max={100} value={percent} /><strong>{percent == null ? '正在下载' : `${percent}%`}</strong><span className="small-note">{((update.downloaded ?? 0) / 1048576).toFixed(1)} MB{update.total ? ` / ${(update.total / 1048576).toFixed(1)} MB` : ''}</span></div>}
    <div className="heading-actions">
      {update.state === 'available' && <Button onClick={() => void action('downloadAndInstall')}>立即更新并重启</Button>}
      {update.state === 'downloading' && <Button kind="secondary" onClick={() => void action('cancel')}>取消下载</Button>}
      {update.state === 'ready' && update.autoInstall && <Button kind="secondary" onClick={() => void action('cancel')}>取消更新</Button>}
      {update.state === 'ready' && !update.autoInstall && <><Button onClick={() => void action('install')}>安装并重启</Button><span className="small-note">也可以稍后再来安装，关闭此页面不会自动安装。</span></>}
      {update.state === 'error' && <Button kind="secondary" onClick={() => void action('check')}>重新检查</Button>}
    </div>
    {update.state === 'manual' && <Notice>管理员尚未关联此平台的签名更新包。补全后，重新检查即可在应用内更新。</Notice>}
    {update.notes && <details className="update-notes" open><summary>本次更新内容</summary><p>{update.notes}</p></details>}
    <p className="small-note">点击更新后，下载和校验完成将自动安装并重启 Coding Access；不会关闭编程工具。</p>
  </section>;
}


export function ClientUpdates(props: { version: string; update: any; action: (operation: string) => Promise<void> }) {
  const [help, setHelp] = useState<'guide' | 'downloads' | null>(null);
  const [shareMessage, setShareMessage] = useState(''); const [shareError, setShareError] = useState(''); const [sharing, setSharing] = useState(false);
  async function share() {
    setSharing(true); setShareMessage(''); setShareError('');
    try {
      const [meta, state, settings] = await Promise.all([api('/api/meta'), desktop!.getState(), desktop!.getSettings!()]);
      if (!meta.capabilities?.downloadSharing) throw new Error('请管理员先升级服务端至 0.1.19，再分享下载链接。');
      const link = new URL('/download', state.serverUrl); link.searchParams.set('channel', settings.preferences.updateChannel === 'beta' ? 'beta' : 'stable');
      await copyText(link.toString()); setShareMessage('下载链接已复制，同事连接公司内网或 VPN 后即可打开下载，无需登录。');
    } catch (e) { setShareError((e as Error).message); } finally { setSharing(false); }
  }
  return <div className="preferences-page page-enter">
    <UpdatesPanel {...props} />
    <div className="about-links"><Button kind="secondary" busy={sharing} onClick={() => void share()}>分享客户端</Button><Button kind="quiet" onClick={() => setHelp('guide')}>使用帮助</Button><Button kind="quiet" onClick={() => setHelp('downloads')}>手动安装包</Button><span className="small-note">Coding Access · 团队模型客户端</span></div>
    {shareMessage && <p className="small-note" role="status">{shareMessage}</p>}{shareError && <Notice error>{shareError}</Notice>}
    {help && <Modal title={help === 'guide' ? '使用帮助' : '手动安装包'} onClose={() => setHelp(null)}><Help version={props.version} mode={help} embedded /></Modal>}
  </div>;
}
