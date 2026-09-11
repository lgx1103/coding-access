import { useEffect, useState } from 'react';
import { changePassword, desktop, type Inspection } from './api.js';
import { AGENTS, type PublicUser } from '../shared/types.js';
import { PASSWORD_MIN_LENGTH } from '../shared/password-policy.js';
import { Select } from './select.js';
import { Button, Field, Loading, Notice } from './components.js';

export function ClientSettings({ user, onLogout }: { user: PublicUser; onLogout: () => void }) {
  const [settings, setSettings] = useState<any>(null); const [platform, setPlatform] = useState('');
  const [server, setServer] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState<Record<string, Inspection>>({});
  const [password, setPassword] = useState({ newPassword: '', confirmation: '' });
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); setMessage(''); try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function inspect() {
    if (!desktop) return;
    const found = await Promise.all(AGENTS.map(async a => [a.id, await desktop!.inspect(a.id)] as const));
    setTools(Object.fromEntries(found));
  }
  useEffect(() => { void run(async () => {
    if (!desktop?.getSettings) throw new Error('此版本不支持原生设置，请升级桌面客户端。');
    const [value, state] = await Promise.all([desktop.getSettings(), desktop.getState()]);
    setSettings(value); setServer(value.preferences.serverUrl); setPlatform(state.platform); await inspect();
  }); }, []);
  useEffect(() => {
    const changed = (event: Event) => setSettings((s: any) => s && ({ ...s, preferences: { ...s.preferences, closeAction: (event as CustomEvent).detail } }));
    window.addEventListener('aca-close-preference-saved', changed);
    return () => window.removeEventListener('aca-close-preference-saved', changed);
  }, []);
  const preferences = settings?.preferences;
  const set = (key: string, value: any) => setSettings((s: any) => ({ ...s, preferences: { ...s.preferences, [key]: value } }));
  return <div className="page-enter preferences-page"><div className="page-heading preferences-heading"><div><h1>设置</h1><p>管理连接、编程工具和本机偏好。</p></div><Button disabled={!preferences || busy} onClick={() => void run(async () => { setSettings(await desktop!.saveSettings!(preferences)); window.dispatchEvent(new Event('aca-settings-saved')); await inspect(); setMessage('设置已保存'); })}>保存设置</Button></div>
    {error && <Notice error>{error}</Notice>}{message && <Notice>{message}</Notice>}
    {!preferences ? busy && <Loading /> : <div className="settings-form">
      <section className="settings-block"><h2>启动与关闭</h2>
        <label className="preference-check"><input type="checkbox" disabled={settings.desktopIntegrationAvailable === false} checked={preferences.startOnLogin ?? false} onChange={e => set('startOnLogin', e.target.checked)} />登录电脑后自动启动 Coding Access</label>
        {settings.desktopIntegrationAvailable === false && <p className="small-note">开发隔离模式不会修改系统登录项，请在安装版中设置。</p>}
        <label className="preference-check"><input type="checkbox" disabled={!preferences.startOnLogin || settings.trayAvailable === false} checked={preferences.startHidden ?? false} onChange={e => set('startHidden', e.target.checked)} />开机启动时隐藏主窗口</label>
        <Field label="点击窗口关闭按钮时"><Select label="关闭窗口行为" value={preferences.closeAction ?? 'ask'} onValueChange={value => set('closeAction', value)} options={[{ value: 'ask', label: '每次询问' }, { value: 'hide', label: platform === 'darwin' ? '隐藏到菜单栏，保持运行' : '隐藏到系统托盘，保持运行' }, { value: 'quit', label: '退出程序' }]} /></Field>
        <p className="small-note">隐藏后可从托盘或菜单栏重新打开；完全退出请使用图标菜单中的「退出」。</p>
      </section>
      <section className="settings-block"><h2>项目与终端</h2><div className="directory-setting"><Field label="默认项目目录"><input value={preferences.projectDirectory} onChange={e => set('projectDirectory', e.target.value)} /></Field><Button kind="quiet" onClick={() => void run(async () => { const path = await desktop!.chooseDirectory(); if (path) set('projectDirectory', path); })}>选择文件夹</Button></div>
        <Field label="终端"><Select label="终端" value={preferences.terminal} onValueChange={value => set('terminal', value)} options={[{value:'',label:'系统默认'}, ...(platform === 'darwin' ? [{value:'Terminal',label:'Terminal'}, {value:'iTerm',label:'iTerm'}] : [{value:'powershell',label:'PowerShell'}, {value:'wt',label:'Windows Terminal'}])]} /></Field><p className="small-note">在所选终端中打开临时会话。</p>
</section>
      <section className="settings-block">        <h2>更新偏好</h2><label className="preference-check"><input type="checkbox" checked={preferences.checkUpdates} onChange={e => set('checkUpdates', e.target.checked)} />登录后自动检查新版本</label><Field label="更新通道"><Select label="更新通道" value={preferences.updateChannel} onValueChange={value => set('updateChannel', value)} options={[{value:'stable',label:'稳定版'}, {value:'beta',label:'测试版（含稳定版）'}]} /></Field>
      </section>
      <section className="settings-block"><h2>公司连接与账号</h2><p>{user.name} · {user.username}</p>
        <Field label="公司服务地址"><input type="url" value={server} readOnly /></Field>
        <div className="heading-actions"><Button kind="secondary" busy={busy} onClick={() => void run(async () => { const value = await desktop!.testConnection!(server); setMessage(`连接成功 · ${value.companyName} · 服务端 ${value.version}`); })}>测试连接</Button><Button kind="quiet" onClick={onLogout}>切换账号或服务地址</Button></div>
        <p className="small-note">切换后需重新登录，模型列表由所连接的公司服务提供。</p>
        {desktop?.clearSavedLogins && <Button kind="quiet" busy={busy} onClick={() => void run(async () => { await desktop!.clearSavedLogins!(); setMessage('已清除保存的账号和密码，当前登录不受影响。'); })}>清除已保存的登录信息</Button>}
        <details><summary>修改密码</summary><form onSubmit={e => { e.preventDefault(); void run(async () => { if (password.newPassword !== password.confirmation) throw new Error('两次新密码输入不一致'); const result = await changePassword(password.newPassword); setPassword({ newPassword: '', confirmation: '' }); setMessage(result.warning ?? '密码已修改，已记住的密码也会同步更新。'); }); }}>
          <Field label={`新密码（至少 ${PASSWORD_MIN_LENGTH} 个字符）`}><input required type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} value={password.newPassword} onChange={e => setPassword(p => ({ ...p, newPassword: e.target.value }))} /></Field>
          <Field label="确认新密码"><input required type="password" autoComplete="new-password" value={password.confirmation} onChange={e => setPassword(p => ({ ...p, confirmation: e.target.value }))} /></Field><Button type="submit" busy={busy}>修改密码</Button>
        </form></details>
      </section>
      <details className="settings-block advanced-settings"><summary>编程工具安装路径<span>自动检测正常时无需修改</span></summary><div><div className="panel-heading"><h2>编程工具</h2><Button kind="quiet" busy={busy} onClick={() => void run(inspect)}>重新检测</Button></div>
        {AGENTS.map(a => <div className="tool-setting" key={a.id}><strong>{a.name} · {tools[a.id]?.installed ? '已检测到' : '未检测到'}</strong><small>{tools[a.id]?.executablePath ?? '可手动指定安装路径'}</small><Field label={`${a.name} 自定义路径`}><input placeholder="留空使用自动检测" value={preferences.toolPaths[a.id] ?? ''} onChange={e => set('toolPaths', { ...preferences.toolPaths, [a.id]: e.target.value })} /></Field><small>配置文件：{tools[a.id]?.path}</small></div>)}
        <p className="small-note">macOS 桌面工具填写 .app 路径；Windows 填写原生可执行文件。仅在 WSL 内安装的工具暂不支持。</p>
      </div></details>
      <details className="settings-block advanced-settings"><summary>备份与排查<span>恢复配置或导出诊断信息</span></summary><div><p className="mono wrap">{settings.backupDirectory}</p><p>每次启用前保存当前配置，保留插件等其他设置。</p>
        <Button kind="secondary" busy={busy} onClick={() => void run(async () => {
          const state = await desktop!.getState();
          const diagnostic = { version: state.version, platform: state.platform, tools: Object.fromEntries(Object.entries(tools).map(([id, t]) => [id, { installed: t.installed, version: t.version }])), note: '未包含账号、服务地址、凭证、项目路径和配置内容。' };
          if (await desktop!.saveText!('coding-access-diagnostics.json', JSON.stringify(diagnostic, null, 2))) setMessage('脱敏诊断信息已导出');
        })}>导出脱敏诊断</Button>
        <details><summary>恢复工具原始配置</summary><p>恢复首次接入前的备份。如需找回某次启用前的配置，可在上方备份目录查找。</p>{AGENTS.filter(a => a.id !== 'codex-desktop').map(a => <Button key={a.id} kind="quiet" busy={busy} onClick={() => void run(async () => { await desktop!.restore(a.id); await inspect(); setMessage(`${a.name} 已恢复`); })}>恢复 {a.name}</Button>)}</details>
      </div></details>
    </div>}
  </div>;
}
