import { useState } from 'react';
import type { Model, ModelAudience, PublicUser } from '../shared/types.js';
import { inModelAudience } from '../shared/model-access.js';
import { Field, Notice } from './components.js';

export function ModelAudienceEditor({ audience, model, users, onChange }: { audience: ModelAudience; model?: Model; users: PublicUser[]; onChange: (value: ModelAudience) => void }) {
  const [query, setQuery] = useState('');
  const selected = audience.type === 'selected' ? audience.userIds : [];
  const members = users.filter(u => u.role !== 'admin' || selected.includes(u.id));
  const visible = members.filter(u => `${u.name} ${u.username}`.toLowerCase().includes(query.toLowerCase()));
  const current = (u: PublicUser) => audience.type === 'all' || selected.includes(u.id);
  const activeMembers = users.filter(u => u.enabled && u.role !== 'admin');
  const added = model?.enabled ? activeMembers.filter(u => current(u) && !inModelAudience(u, model)).length : 0;
  const removed = model?.enabled ? activeMembers.filter(u => !current(u) && inModelAudience(u, model)).length : 0;
  return <section className="model-audience" aria-labelledby="audience-heading">
    <div className="form-section-heading"><div><h3 id="audience-heading">使用范围</h3><p>发布后按此范围开放，管理员可访问全部已发布模型。</p></div></div>
    <div className="audience-options">
      <label className={`audience-option ${audience.type === 'all' ? 'selected' : ''}`}><input type="radio" name="audience" checked={audience.type === 'all'} onChange={() => onChange({ type: 'all' })} /><span><strong>全体成员</strong><small>现有及未来新增的启用成员自动可用</small></span></label>
      <label className={`audience-option ${audience.type === 'selected' ? 'selected' : ''}`}><input type="radio" name="audience" checked={audience.type === 'selected'} onChange={() => onChange(model?.audience?.type === 'selected' ? model.audience : { type: 'selected', userIds: [] })} /><span><strong>指定成员</strong><small>仅所选成员可用，新增成员不会自动加入</small></span></label>
    </div>
    {audience.type === 'selected' && <div className="audience-members">
      <Field label="搜索发布对象"><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索姓名或账号" /></Field>
      <div className="audience-member-list">{visible.map(u => <label className="audience-member" key={u.id}>
        <input type="checkbox" checked={selected.includes(u.id)} disabled={!u.enabled && !selected.includes(u.id)} onChange={e => onChange({ type: 'selected', userIds: e.target.checked ? [...selected, u.id] : selected.filter(id => id !== u.id) })} />
        <span><strong>{u.name}</strong><small>{u.username}</small></span>{(!u.enabled || u.role === 'admin') && <small className="audience-member-state">{!u.enabled ? '账号已停用' : '管理员'}</small>}
      </label>)}{!visible.length && <p className="small-note">{query ? '没有找到匹配成员' : '尚无可选择的成员，可先保存草稿。'}</p>}</div>
      <p className="small-note">已选择 {selected.length} 位；其中 {activeMembers.filter(current).length} 位启用成员。停用账号仍不能使用。</p>
    </div>}
    {model?.enabled && (added > 0 || removed > 0) && <Notice>保存后将新增 {added} 位、移除 {removed} 位成员的访问权限。移除后，后续请求及尚未发出的排队请求将被拒绝。</Notice>}
    <p className="publication-result">{model?.enabled ? '保存后开放给' : '发布给'}{audience.type === 'all' ? '全体成员（含未来新成员）' : `所选 ${selected.length} 位成员`}。{!model?.enabled && '保存草稿不会向成员开放。'}</p>
  </section>;
}
