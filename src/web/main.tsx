import { changePassword } from './api.js';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowRight, Box, CircleHelp, Download, Eye, EyeOff, Layers, LayoutDashboard, LogOut, Monitor, Settings2, ShieldCheck, UserRound, Users } from 'lucide-react';
import { api, desktop } from './api.js';
import { Button, Field, Mark, Notice, Toast } from './components.js';
import { Employee } from './employee.js';
import { ClientUpdates, useUpdates } from './updates.js';
import { ReleaseAdmin } from './release-admin.js';
import { ClientSettings } from './client-settings.js';
import { Analytics } from './analytics.js';
import { Overview } from './overview.js';
import { Resources } from './resources.js';
import { Models } from './models.js';
import { UsersPage as Members } from './users.js';
import { Maintenance, Requests } from './requests.js';
import { Help } from './help.js';
import { LegacyMigration, AutomaticUpgradeNotice } from './legacy-migration.js';
import type { PublicUser } from '../shared/types.js';
import { APP_VERSION } from '../shared/version.js';
import { DEFAULT_SERVICE_URL } from '../shared/service-url.js';
import { PASSWORD_MIN_LENGTH } from '../shared/password-policy.js';
import { WindowControls } from './window-controls.js';
import { usePageNavigation } from './page-navigation.js';
import './styles.css';
import './client-focus.css';

interface Metadata { companyName?: string; version?: string; demo?: boolean }
const navigation = [
  { id: 'overview', label: '工作台', icon: LayoutDashboard },
  { id: 'providers', label: '供应商', icon: Box },
  { id: 'resources', label: '密钥池', icon: ShieldCheck },
  { id: 'models', label: '模型目录', icon: Layers },
  { id: 'users', label: '团队成员', icon: Users },
  { id: 'requests', label: '用量统计', icon: Activity },
];

function Brand({ subtitle = '管理控制台' }: { subtitle?: string }) {
  return <div className="wordmark"><Mark /><span>Coding Access<small>{subtitle}</small></span></div>;
}

function PasswordField({ id, label, value, onChange, autoComplete, hint, minLength, disabled, saved = false }: {
  id: string; label: string; value: string; onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password'; hint?: string; minLength?: number; disabled?: boolean; saved?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return <div className="field">
    <label htmlFor={id}>{label}</label>
    <div className="password-input">
      <input id={id} required={!saved} type={visible ? 'text' : 'password'} autoComplete={autoComplete} value={value}
        onChange={e => onChange(e.target.value)} placeholder={saved ? '已保存密码，直接点击登录' : `输入${label}`} minLength={minLength}
        disabled={disabled} aria-describedby={hint ? `${id}-hint` : undefined} />
      <button className="password-toggle" type="button" aria-label={visible ? `隐藏${label}` : `显示${label}`}
        title={visible ? `隐藏${label}` : `显示${label}`} aria-pressed={visible} disabled={disabled} onClick={() => setVisible(!visible)}>
        {visible ? <EyeOff size={19} /> : <Eye size={19} />}
      </button>
    </div>
    {hint && <small id={`${id}-hint`}>{hint}</small>}
  </div>;
}

function Login({ onLogin, demo, server, version, development }: {
  onLogin: (user: PublicUser, server: string) => void; demo: boolean; server: string; version: string; development: boolean;
}) {
  const [url, setUrl] = useState(server || (desktop ? DEFAULT_SERVICE_URL : ''));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loginHint, setLoginHint] = useState('');
  const [lookup, setLookup] = useState(false);
  const restoredUrl = useRef('');
  useEffect(() => {
    let active = true;
    setSaved(false); setRemember(false); setLookup(false);
    if (!desktop?.getRememberedLogin || !url || (!username && restoredUrl.current === url)) return;
    if (!username) restoredUrl.current = url;
    setLookup(true);
    void desktop.getRememberedLogin(url, username || undefined).then(value => {
      if (!active) return;
      if (!username && value.username) setUsername(value.username);
      setSaved(value.remembered); setRemember(value.remembered);
    }).catch(() => {}).finally(() => { if (active) setLookup(false); });
    return () => { active = false; };
  }, [url, username]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  async function login(e: React.FormEvent) {
    e.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const result = desktop
        ? await desktop.login(url, username, password, remember, saved && !password)
        : await api('/api/auth/login', 'POST', { username, password, client: 'browser', device: 'browser' });
      onLogin(result.user, url);
    } catch (e) { setError((e as Error).message); }
    finally { pending.current = false; setBusy(false); }
  }
  return <main className={`login-layout ${desktop ? 'desktop-login' : ''}`}>
    <header className="login-brand"><Brand subtitle={desktop ? (development ? 'Tauri 开发版 · 独立配置' : '桌面客户端') : '管理控制台'} /></header>
    <div className="login-content">
      <section className="login-intro" aria-labelledby="login-intro-title">
        <div className="login-intro-copy">
          <h1 id="login-intro-title">{desktop ? '使用团队模型' : '团队模型管理'}</h1>
          <p>{desktop ? <>选择公司提供的模型，配置编程工具。<br />查看个人用量与连接状态。</> : <>管理供应商接入、模型与成员权限。<br />查看调用记录和团队用量。</>}</p>
        </div>
        <p className="login-network"><ShieldCheck size={22} />公司内网 / VPN 访问</p>
      </section>
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-card-heading"><h2 id="login-title">{desktop ? '登录 Coding Access' : '登录管理后台'}</h2><p>使用公司账号登录。</p></div>
        {error && <Notice error>{error}</Notice>}
        <form className="login-form" onSubmit={login} aria-busy={busy}>
          {desktop && <Field label="公司服务地址"><input type="url" required value={url} disabled={busy}
            onChange={e => { setUrl(e.target.value); setUsername(''); setPassword(''); setSaved(false); }} placeholder={DEFAULT_SERVICE_URL} spellCheck={false} autoCapitalize="none" /></Field>}
          <Field label="账号"><input required autoFocus autoComplete="username" value={username} disabled={busy}
            onChange={e => { setUsername(e.target.value); setPassword(''); setSaved(false); }} placeholder="输入账号" autoCapitalize="none" spellCheck={false} /></Field>
          <PasswordField id="login-password" label="密码" value={password} onChange={setPassword} autoComplete="current-password" saved={saved && !password} disabled={busy} />
          {desktop?.getRememberedLogin && <div className="login-options"><label><input type="checkbox" checked={remember} disabled={busy || lookup} onChange={e => {
            const checked = e.target.checked; setRemember(checked);
            if (!checked) { setSaved(false); void desktop!.forgetLogin!(url, username).catch(e => setError(e.message)); }
          }} />记住密码</label><button type="button" className="text-button" onClick={() => setLoginHint('已保存密码时可直接登录；未保存且忘记密码，请联系管理员重置。')}>忘记密码？</button></div>}
          {loginHint && <p className="small-note" role="status">{loginHint}</p>}
          <Button type="submit" busy={busy} disabled={lookup} className="full-width">{busy ? '正在登录' : '登录'}<ArrowRight size={19} /></Button>
        </form>
        {!desktop?.getRememberedLogin && <p className="login-help">忘记密码请联系管理员。</p>}
        {development ? <LegacyMigration development disabled={busy} onPreferences={setUrl} /> : <AutomaticUpgradeNotice disabled={busy} onChecked={state => setUrl(state.serverUrl)} />}
        {demo && <div className="demo-login"><strong>本地演示环境</strong><p>管理员 <code>admin</code> · 员工 <code>dev1</code><br />密码均为 <code>DemoAccess2026!</code></p><small>仅使用模拟数据。</small></div>}
      </section>
    </div>
    <footer className="login-version">Coding Access <span>·</span> {version}</footer>
  </main>;
}

function LogoutButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return <Button kind="quiet" className="logout-button" busy={busy} onClick={onClick}>{!busy && <LogOut size={16} />}<span>{busy ? '正在退出' : '退出登录'}</span></Button>;
}

function PasswordChange({ onDone, onLogout, logoutBusy, logoutError }: {
  onDone: (warning?: string) => Promise<void>; onLogout: () => void; logoutBusy: boolean; logoutError: string;
}) {
  const [newPassword, setNew] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setError('');
    if (pending.current || logoutBusy) return;
    if (newPassword !== confirmation) return setError('两次新密码输入不一致');
    pending.current = true; setBusy(true);
    try { const result = await changePassword(newPassword); await onDone(result.warning); }
    catch (e) { setError((e as Error).message); }
    finally { pending.current = false; setBusy(false); }
  }
  return <main className="password-page">
    <header className="password-header"><Brand subtitle={desktop ? '桌面客户端' : '管理控制台'} /><LogoutButton busy={logoutBusy} onClick={onLogout} /></header>
    <section className="panel password-panel" aria-labelledby="password-title">
      <div className="login-card-heading"><h1 id="password-title">设置登录密码</h1><p>首次登录，请更换管理员分配的初始密码。</p></div>
      {(error || logoutError) && <Notice error>{logoutError || error}</Notice>}
      <form className="login-form" onSubmit={save} aria-busy={busy}>
        <PasswordField id="new-password" label="新密码" value={newPassword} onChange={setNew} autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH}
          hint={`至少 ${PASSWORD_MIN_LENGTH} 个字符。`} disabled={busy || logoutBusy} />
        <PasswordField id="confirm-password" label="确认新密码" value={confirmation} onChange={setConfirmation} autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} disabled={busy || logoutBusy} />
        <Button type="submit" busy={busy} disabled={logoutBusy} className="full-width">保存并进入<ArrowRight size={17} /></Button>
      </form>
    </section>
  </main>;
}

function App() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const { update, action: updateAction } = useUpdates(user?.id);
  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState<Metadata>({});
  const [server, setServer] = useState('');
  const [version, setVersion] = useState(APP_VERSION);
  const [development, setDevelopment] = useState(false);
  const [page, setPage] = usePageNavigation(user?.role, Boolean(desktop));
  const [keyProvider, setKeyProvider] = useState('all');
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [page]);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [logoutBusy, setLogoutBusy] = useState(false);
  const logoutPending = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  function setIdentity(next: PublicUser | null) {
    setUser(next); if (desktop) setPage('overview'); setToast(''); setError('');
  }
  async function load() {
    try {
      if (desktop) {
        const state = await desktop.getState(); setServer(state.serverUrl); setVersion(state.version); setDevelopment(Boolean(state.development));
        if (!state.serverUrl) { setIdentity(null); return; }
      }
      const results = await Promise.allSettled([api<Metadata>('/api/meta'), api<{ user: PublicUser }>('/api/auth/me')]);
      if (results[0].status === 'fulfilled') setMeta(results[0].value);
      setIdentity(results[1].status === 'fulfilled' ? results[1].value.user : null);
    } catch { setIdentity(null); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const expired = () => { if (!logoutPending.current) setIdentity(null); };
    window.addEventListener('aca-auth-expired', expired);
    return () => window.removeEventListener('aca-auth-expired', expired);
  }, []);
  useEffect(() => { if (error) errorRef.current?.scrollIntoView({ block: 'nearest' }); }, [error]);
  async function logout() {
    if (logoutPending.current) return;
    logoutPending.current = true; setLogoutBusy(true); setError('');
    try {
      if (desktop) await desktop.logout(); else await api('/api/auth/logout', 'POST');
      setIdentity(null);
    } catch (e) { setError(`退出登录失败：${(e as Error).message}`); }
    finally { logoutPending.current = false; setLogoutBusy(false); }
  }
  const admin = user?.role === 'admin' && !desktop;
  const pageTitle = page === 'settings' ? admin ? '设置与维护' : '设置' : page === 'help' ? desktop ? '更新与关于' : admin ? '客户端发布' : '客户端与帮助' : admin ? navigation.find(item => item.id === page)?.label ?? '设置与维护' : page === 'usage' ? '我的用量' : '开始编程';
  if (loading) return <div className="boot" role="status"><Mark /><span>正在连接服务…</span></div>;
  if (!user) return <Login development={development} demo={Boolean(meta.demo)} server={server} version={version} onLogin={(next, url) => {
    setServer(url); setIdentity(next); void api<Metadata>('/api/meta').then(setMeta).catch(() => {});
  }} />;
  if (user.mustChangePassword) return <PasswordChange onDone={async warning => { await load(); if (warning) setToast(warning); }} onLogout={() => void logout()} logoutBusy={logoutBusy} logoutError={error} />;
  return <div className={`app-shell ${admin ? '' : 'employee-shell'}`}>
    <aside className="sidebar">
      <Brand subtitle={admin ? '管理控制台' : desktop ? (development ? 'Tauri 开发版 · 独立配置' : '桌面客户端') : '模型使用'} />
      <div className="sidebar-scroll">
        <nav className="sidebar-nav" aria-label={admin ? '管理导航' : '客户端导航'}>
          {admin ? navigation.map(item => <button key={item.id} type="button" className={page === item.id ? 'active' : ''}
            aria-current={page === item.id ? 'page' : undefined} onClick={() => setPage(item.id)}><item.icon size={21} /><span>{item.label}</span></button>)
            : <><button type="button" className={page === 'overview' ? 'active' : ''} aria-current={page === 'overview' ? 'page' : undefined}
              onClick={() => setPage('overview')}><Monitor size={21} /><span>开始编程</span></button><button type="button" className={page === 'usage' ? 'active' : ''} aria-current={page === 'usage' ? 'page' : undefined}
              onClick={() => setPage('usage')}><Activity size={21} /><span>我的用量</span></button></>}
        </nav>
        <nav className="secondary-nav" aria-label="设置与帮助">
          {(admin || desktop) && <button type="button" className={page === 'settings' ? 'active' : ''} aria-current={page === 'settings' ? 'page' : undefined}
            onClick={() => setPage('settings')}><Settings2 size={21} /><span>{admin ? '设置与维护' : '设置'}</span></button>}
          <button type="button" className={page === 'help' ? 'active' : ''} aria-current={page === 'help' ? 'page' : undefined}
            onClick={() => setPage('help')}>{admin ? <Download size={21} /> : <CircleHelp size={21} />}<span>{desktop ? '更新与关于' : admin ? '客户端发布' : '客户端与帮助'}{desktop && update.available && <small className="update-badge">● 有新版本</small>}</span></button>
        </nav>
      </div>
      <footer className="sidebar-footer">Coding Access <span>·</span> {version}</footer>
    </aside>
    <div className="main-frame">
      <header className="topbar">
        <div className="topbar-actions">
          {meta.demo && <span className="demo-badge">演示环境</span>}
          <div className="account-info"><span className="top-avatar" aria-hidden="true"><UserRound size={19} /></span><span className="account-name" title={user.name}>{user.name}</span></div>
          <LogoutButton busy={logoutBusy} onClick={() => void logout()} />
        </div>
      </header>
      <main className="main-content" aria-label={pageTitle} key={`${user.id}:${admin ? 'admin' : 'employee'}`}>
        {error && <div ref={errorRef} className="shell-alert"><Notice error>{error}</Notice></div>}
        {page === 'help' ? desktop ? <ClientUpdates version={version} update={update} action={updateAction} /> : admin ? <ReleaseAdmin /> : <Help version={version} /> : admin
          ? page === 'overview' ? <Overview navigate={setPage} />
            : page === 'providers' ? <Resources key="providers" mode="providers" notify={setToast} onViewKeys={providerId => { setKeyProvider(providerId); setPage('resources'); }} />
            : page === 'resources' ? <Resources key="keys" initialProvider={keyProvider} onProviderChange={setKeyProvider} onProviders={() => setPage('providers')} notify={setToast} />
              : page === 'models' ? <Models notify={setToast} />
                : page === 'users' ? <Members notify={setToast} onManageModels={() => setPage('models')} />
                  : page === 'requests' ? <Analytics /> : <Maintenance notify={setToast} />
          : page === 'settings' ? <ClientSettings user={user} onLogout={() => void logout()} /> : page === 'usage' ? <Analytics personal /> : <Employee notify={setToast} />}
      </main>
    </div>
    {toast && <Toast message={toast} onClose={() => setToast('')} />}
  </div>;
}
createRoot(document.getElementById('root')!).render(<><App /><WindowControls /></>);
