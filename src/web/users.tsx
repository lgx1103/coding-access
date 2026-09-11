import { Select } from './select.js';
import { useState } from 'react';
import { Check, KeyRound, Pencil, Plus, Search, ShieldCheck, UserRound } from 'lucide-react';
import type { Model, PublicUser } from '../shared/types.js';
import { canUseModel } from '../shared/model-access.js';
import { PASSWORD_MIN_LENGTH } from '../shared/password-policy.js';
import { api, dateTime } from './api.js';
import { Button, ConfirmAction, Empty, Field, Loading, Modal, Notice, Refresh, Status, useData } from './components.js';

function UserForm({ user, models, onManageModels, onClose, onSaved }: { user?: PublicUser; models: Model[]; onManageModels: () => void; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ username: user?.username ?? '', name: user?.name ?? '', role: user?.role ?? 'employee', enabled: user?.enabled ?? true, password: '' });
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const update = (key: string, value: unknown) => setForm(f => ({ ...f, [key]: value }));
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { await api(`/api/admin/users${user ? `/${user.id}` : ''}`, user ? 'PUT' : 'POST', user ? { name: form.name, role: form.role, enabled: form.enabled } : { username: form.username, name: form.name, role: form.role, password: form.password }); onSaved(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); }
  }
  return <Modal title={user ? `管理 ${user.name}` : '添加团队成员'} subtitle="设置账号与角色，查看当前可用模型。" onClose={onClose} onSubmit={save} footer={<><Button kind="secondary" type="button" onClick={onClose}>取消</Button><Button busy={busy} type="submit"><Check size={16} />{user ? '保存修改' : '创建账号'}</Button></>}>{error && <Notice error>{error}</Notice>}
    <div className="form-grid"><Field label="姓名"><input required value={form.name} onChange={e => update('name', e.target.value)} placeholder="成员姓名" /></Field><Field label="登录账号"><input required autoComplete="username" disabled={Boolean(user)} value={form.username} onChange={e => update('username', e.target.value)} placeholder="字母、数字或短横线" pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]*" /></Field></div>
    {!user && <Field label="初始密码" hint={`至少 ${PASSWORD_MIN_LENGTH} 个字符，成员首次登录时需要修改。`}><input type="password" required minLength={PASSWORD_MIN_LENGTH} autoComplete="new-password" value={form.password} onChange={e => update('password', e.target.value)} /></Field>}
    <Field label="角色"><Select value={form.role} onValueChange={value => update('role', value)} options={[{ value: 'employee', label: '成员' }, { value: 'admin', label: '管理员' }]} /></Field>
    <div className="form-section-heading"><div><h3>可用模型</h3><p>{!form.enabled ? '账号停用后无法使用模型。' : form.role === 'admin' ? '管理员可访问全部已发布模型。' : '仅展示已发布且在使用范围内的模型。'}</p></div></div>
    <div className="member-models" aria-label="当前可用模型">{models.filter(m => canUseModel({ id: user?.id ?? '', models: [], role: form.role, enabled: form.enabled }, m)).map(m => <div className="member-model" key={m.id}><span>{m.name}</span><small>{form.role === 'admin' ? '管理员可用' : m.audience?.type === 'all' ? '全体成员开放' : '单独授权'}</small></div>)}</div>
    {!models.some(m => canUseModel({ id: user?.id ?? '', models: [], role: form.role, enabled: form.enabled }, m)) && <p className="small-note">暂无可用模型。</p>}
    <button type="button" className="text-button" onClick={onManageModels}>管理模型开放范围 →</button>
    {user && <label className="switch-line"><span><strong>启用账号</strong><small>停用会撤销该成员全部访问凭证。</small></span><input type="checkbox" role="switch" checked={form.enabled} onChange={e => update('enabled', e.target.checked)} /></label>}
    {user && <ConfirmAction path={`/api/admin/users/${user.id}/revoke`} method="POST" label="撤销全部凭证" detail="此成员的所有设备需要重新登录并应用配置，密码保持不变。其他成员继续正常使用。" onDone={() => { onSaved(); onClose(); }} />}
  </Modal>;
}
function ResetPassword({ user, onClose, notify }: { user: PublicUser; onClose: () => void; notify: (m: string) => void }) {
  const [value, setValue] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <Modal title={`重置 ${user.name} 的密码`} subtitle="旧登录和访问凭证将被撤销，成员需要重新登录并应用配置。" onClose={onClose} onSubmit={e => { e.preventDefault(); setBusy(true); void api(`/api/admin/users/${user.id}/reset-password`, 'POST', { password: value }).then(() => { notify('密码已重置，旧凭证已撤销'); onClose(); }).catch(e => setError(e.message)).finally(() => setBusy(false)); }} footer={<><Button kind="secondary" type="button" onClick={onClose}>取消</Button><Button type="submit" busy={busy}>重置密码</Button></>}>{error && <Notice error>{error}</Notice>}<Field label="新的初始密码" hint={`至少 ${PASSWORD_MIN_LENGTH} 个字符。`}><input required type="password" minLength={PASSWORD_MIN_LENGTH} autoComplete="new-password" value={value} onChange={e => setValue(e.target.value)} /></Field></Modal>;
}
export function UsersPage({ notify, onManageModels }: { notify: (m: string) => void; onManageModels: () => void }) {
  const users = useData<{ users: PublicUser[] }>('/api/admin/users'); const models = useData<{ models: Model[] }>('/api/admin/models');
  const [query, setQuery] = useState(''); const [editing, setEditing] = useState<PublicUser | 'new' | null>(null); const [reset, setReset] = useState<PublicUser | null>(null);
  const list = users.data?.users.filter(u => `${u.name} ${u.username}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <div className="page-enter"><div className="page-heading"><div><h1>团队成员</h1><p>管理账号与访问凭证，查看成员实际可用的模型。</p></div><Button disabled={!models.data || Boolean(models.error)} onClick={() => setEditing('new')}><Plus size={17} />添加成员</Button></div>
    {(users.error || models.error) && <Notice error>{users.error || models.error}</Notice>}
    <section className="panel"><div className="panel-heading"><div><h2>团队成员 <span className="count">{users.data?.users.length ?? 0}</span></h2><p>公司模型服务的账号与权限</p></div><div className="table-tools"><div className="search-input"><Search size={16} /><input aria-label="搜索成员" placeholder="搜索姓名或账号" value={query} onChange={e => setQuery(e.target.value)} /></div><Refresh busy={users.loading} onClick={() => { void users.refresh(); void models.refresh(); }} /></div></div>
    {users.loading && !users.data ? <Loading /> : list.length ? <div className="table-scroll"><table><thead><tr><th>成员</th><th>角色</th><th>可用模型</th><th>加入时间</th><th>账号状态</th><th className="right">操作</th></tr></thead><tbody>{list.map((user, i) => <tr key={user.id}><td><div className="person-cell"><span className={`avatar avatar-${i % 4}`}>{user.name.slice(-2)}</span><div><strong>{user.name}</strong><small>{user.username}</small></div></div></td><td><span className="role-label">{user.role === 'admin' ? <ShieldCheck size={14} /> : <UserRound size={14} />}{user.role === 'admin' ? '管理员' : '成员'}</span></td><td>{!user.enabled ? '账号已停用' : user.role === 'admin' ? '全部已发布模型' : `${user.models.length} 个模型`}</td><td className="muted">{dateTime(user.createdAt)}</td><td><Status value={user.enabled ? 'enabled' : 'disabled'} />{user.mustChangePassword && <small className="cell-caption">首次登录待修改密码</small>}</td><td><div className="row-actions"><button className="icon-button" disabled={!models.data || Boolean(models.error)} aria-label={`管理 ${user.name}`} onClick={() => setEditing(user)}><Pencil size={15} /></button><button className="icon-button" aria-label={`重置 ${user.name} 的密码`} onClick={() => setReset(user)}><KeyRound size={15} /></button></div></td></tr>)}</tbody></table></div> : <Empty title={query ? '没有找到匹配成员' : '添加第一位团队成员'} />}
    </section>{editing && <UserForm user={editing === 'new' ? undefined : editing} models={models.data?.models ?? []} onManageModels={onManageModels} onClose={() => setEditing(null)} onSaved={() => { void users.refresh(); notify('成员配置已保存'); }} />}{reset && <ResetPassword user={reset} onClose={() => setReset(null)} notify={notify} />}
  </div>;
}
