import { Select } from './select.js';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronDown, Layers3, Pencil, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { modelBrand, providerBrand } from '../shared/brand.js';
import { BrandIcon } from './brand-icon.js';
import { AGENTS, type Model, type Provider, type PublicUser } from '../shared/types.js';
import { ModelAudienceEditor } from './model-audience.js';
import { audienceLabel, publicationLabel } from '../shared/model-access.js';
import { api } from './api.js';
import { profileForModel, resolveModelCapabilities, unifyModelCapabilities } from '../shared/model-capabilities.js';
import { Button, ConfirmAction, Empty, Field, Loading, Modal, Notice, Refresh, Status, useData } from './components.js';


function ModelForm({ model, providers, users, onClose, onSaved }: { model?: Model; providers: Provider[]; users: PublicUser[]; onClose: () => void; onSaved: (message: string) => void }) {
  const [form, setForm] = useState<Omit<Model, 'createdAt'>>(model ? unifyModelCapabilities(model, providers) : {
    id: '', name: '', description: '', enabled: false, audience: { type: 'all' }, agents: AGENTS.map(agent => agent.id), capabilityMode: 'unified',
    routes: providers[0] ? [{ providerId: providers[0].id, upstreamModel: '', weight: 2 }] : [],
  });
  const [withdrawing, setWithdrawing] = useState(false);
  const [showDescription, setShowDescription] = useState(Boolean(model?.description));
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [impact, setImpact] = useState<any>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (model) void api(`/api/admin/models/${encodeURIComponent(model.id)}/impact`).then(value => { if (active.current) setImpact(value); }).catch(() => {}); }, [model]);
  const touched = useRef({ context: Boolean(model), vision: Boolean(model) });
  const routeSignature = form.routes.map(r => `${r.providerId}:${r.upstreamModel}`).join('|');
  useEffect(() => {
    const presets = resolveModelCapabilities(form, providers);
    const vision = presets.routes.some(r => r.vision === false) ? false : presets.routes.length && presets.routes.every(r => r.vision === true) ? true : undefined;
    setForm(f => ({ ...f, ...(!touched.current.context ? { contextWindow: presets.contextWindow } : {}), ...(!touched.current.vision ? { vision } : {}) }));
  }, [routeSignature, providers]);
  const effective = form;
  const mixedModels = new Set(form.routes.map(r => profileForModel(providers.find(p => p.id === r.providerId), r.upstreamModel)?.id).filter(Boolean)).size > 1;
  const update = (key: string, value: unknown) => setForm(f => ({ ...f, [key]: value,
    // Explicitly changing the common capability replaces legacy route overrides.
    ...(key === 'contextWindow' || key === 'vision' ? { routes: f.routes.map(r => ({ ...r, [key]: undefined })) } : {}),
  }));
  const route = (index: number, key: string, value: unknown) => setForm(f => ({ ...f, routes: f.routes.map((r, i) => i === index ? { ...r, [key]: value } : r) }));
  async function save(e: React.FormEvent) {
    e.preventDefault(); setError('');
    if (mixedModels) { setError('同一个模型条目请使用同一型号，不同模型需要分别创建。'); return; }
    if (!form.agents.length) { setError('至少选择一个编程工具。'); return; }
    const intent = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') ?? (model?.enabled ? 'save' : 'draft');
    const enabled = intent === 'publish' || (intent === 'save' && Boolean(model?.enabled));
    if (enabled && form.audience?.type === 'selected' && !form.audience.userIds.length && !(model?.enabled && model.audience?.type === 'selected' && !model.audience.userIds.length)) { setError('请至少选择一位成员，或选择全体成员后发布；也可先保存草稿。'); return; }
    setBusy(true);
    try {
      const { id: _, ...data } = effective;
      await api(model ? `/api/admin/models/${encodeURIComponent(model.id)}` : '/api/admin/models', model ? 'PUT' : 'POST', { ...data, enabled, ...(model ? { id: model.id } : {}), name: form.name.trim(), description: form.description.trim() });
      onSaved(enabled ? `模型已发布 · ${audienceLabel({ ...form, createdAt: 0 })}，成员刷新即可查看` : intent === 'withdraw' ? '模型已下架，原使用范围已保留' : model?.everPublished ? '配置已保存，模型保持已下架' : '草稿已保存，尚未向成员开放'); if (active.current) onClose();
    } catch (e) { if (active.current) setError(e instanceof Error ? e.message : '保存失败'); }
    finally { if (active.current) setBusy(false); }
  }
  const numeric = (value: string) => value.trim() ? Number(value) : undefined;
  return <Modal title={model ? `配置 ${model.name}` : '新增模型'} subtitle="填写模型信息及参与分配的供应商。" onClose={onClose} wide onSubmit={save}
    footer={<><Button type="button" kind="secondary" onClick={onClose}>取消</Button>{model?.enabled ? <><Button type="button" kind="secondary" disabled={busy} onClick={() => setWithdrawing(!withdrawing)}>{withdrawing ? '取消下架' : '下架模型'}</Button><Button type="submit" value={withdrawing ? 'withdraw' : 'save'} kind={withdrawing ? 'danger' : 'primary'} busy={busy} disabled={mixedModels}><Check size={16} />{withdrawing ? '确认下架' : '保存修改'}</Button></> : <><Button type="submit" value="draft" kind="secondary" busy={busy} disabled={mixedModels}>{model?.everPublished ? '保存修改' : '保存草稿'}</Button><Button type="submit" value="publish" busy={busy} disabled={mixedModels}><Check size={16} />{model?.everPublished ? '重新发布' : '发布模型'}</Button></>}</>}>
    {error && <Notice error>{error}</Notice>}
    {withdrawing && <Notice error>确认保存当前修改并下架此模型？当前 {impact?.users?.length ?? "…"} 位启用成员将无法发起新请求，尚未发出的排队请求也会被拒绝；已经发给供应商的请求继续处理。</Notice>}
    <Field label="模型名称"><input required value={form.name} onChange={e => update('name', e.target.value)} placeholder="例如：GLM-5.3" /></Field>
    {showDescription ? <div className="optional-description"><Field label="使用说明（可选）"><textarea rows={2} maxLength={500} value={form.description} onChange={e => update('description', e.target.value)} placeholder="例如：适合复杂项目；需要快速响应时请选择 Flash。" /></Field><button type="button" className="text-button muted" onClick={() => { update('description', ''); setShowDescription(false); }}>移除说明</button></div>
      : <button type="button" className="text-button optional-description-toggle" onClick={() => setShowDescription(true)}><Plus size={14} />添加使用说明</button>}
    <div className="model-capability-fields form-grid">
      <div className="context-field"><Field label="上下文窗口" hint={form.contextWindow === undefined ? '未设置，编程工具可能使用较小的默认窗口。' : '所有关联供应商应共同支持此容量，单位：token。'}><input type="number" min={1024} max={4000000} value={form.contextWindow ?? ''} onChange={e => { touched.current.context = true; update('contextWindow', numeric(e.target.value)); }} placeholder="未设置" /></Field><Button type="button" kind="secondary" onClick={() => { touched.current.context = true; update('contextWindow', 1000000); }}>设为 1M</Button></div>
      <Field label="图片输入" hint="选择支持时，所有关联供应商都应支持图片。"><Select value={form.vision === undefined ? 'unknown' : form.vision ? 'supported' : 'unsupported'} onValueChange={value => { touched.current.vision = true; update('vision', value === 'unknown' ? undefined : value === 'supported'); }} options={[{ value: 'unknown', label: '未设置' }, { value: 'supported', label: '支持' }, { value: 'unsupported', label: '不支持' }]} /></Field>
    </div>
    {!model && form.routes.some(r => profileForModel(providers.find(p => p.id === r.providerId), r.upstreamModel)) && <p className="small-note">已按匹配的内置资料预填能力，可按实际套餐修改。</p>}
    <div className="form-section-heading"><div><h3>参与分配的供应商</h3><p>同一版本的模型共同分担请求，权重越高越优先。</p></div><Button type="button" kind="quiet" disabled={form.routes.length >= providers.length} onClick={() => {
      const provider = providers.find(p => !form.routes.some(r => r.providerId === p.id));
      if (provider) {
        update('routes', [...form.routes, { providerId: provider.id, upstreamModel: '', weight: 1 }]);
      }
    }}><Plus size={15} />添加供应商</Button></div>
    <div className="route-list">{form.routes.map((r, i) => <div className="route-editor compact-route" key={r.providerId + i}>
      <div className="route-fields"><div className="route-main-fields">
        <Field label="供应商"><Select value={r.providerId} onValueChange={value => {
          update('routes', form.routes.map((entry, index) => index === i ? { ...entry, providerId: value, contextWindow: undefined, vision: undefined } : entry));
        }} options={providers.filter(p => p.id === r.providerId || !form.routes.some(entry => entry.providerId === p.id)).map(p => ({ value: p.id, label: p.name }))} required /></Field>
        <Field label="模型ID"><input required value={r.upstreamModel} onChange={e => route(i, 'upstreamModel', e.target.value)} placeholder="例如：glm-5.3" autoComplete="off" autoCapitalize="none" spellCheck={false} /></Field>
        <Field label="权重"><input type="number" required min={0.01} max={1000} step={0.01} value={r.weight} onChange={e => route(i, 'weight', e.target.value === '' ? '' : Number(e.target.value))} /></Field>
      </div></div><button type="button" className="icon-button" aria-label={`移除第 ${i + 1} 个供应商`} disabled={form.routes.length <= 1} onClick={() => update('routes', form.routes.filter((_, index) => index !== i))}><Trash2 size={15} /></button>
    </div>)}</div>
    {mixedModels && <Notice error>同一个模型条目请使用同一型号，不同模型需要分别创建。</Notice>}
    <ModelAudienceEditor audience={form.audience ?? { type: 'selected', userIds: [] }} model={model} users={users} onChange={audience => update('audience', audience)} />
    <details className="advanced model-advanced"><summary><span>高级设置</span><ChevronDown size={16} /></summary>
      <Field label="单次输出上限（可选）" hint="留空不覆盖编程工具或供应商的输出设置。"><input type="number" min={1} max={512000} value={form.maxOutputTokens ?? ''} onChange={e => update('maxOutputTokens', numeric(e.target.value))} placeholder="未设置" /></Field>
      <div className="form-section-heading"><div><h3>开放工具</h3></div></div><div className="checkbox-row">{AGENTS.map(a => <label className="check-field" key={a.id}><input type="checkbox" checked={form.agents.includes(a.id)} onChange={e => update('agents', e.target.checked ? [...form.agents, a.id] : form.agents.filter(x => x !== a.id))} />{a.name}</label>)}</div>
    </details>
    {model && !model.enabled && <ConfirmAction path={`/api/admin/models/${encodeURIComponent(model.id)}`} label="删除模型" detail="删除此目录条目并移除成员对此模型的授权，历史调用记录保留。恢复配置版本后需重新授权。" onDone={() => { onSaved('模型已删除，历史调用记录已保留'); if (active.current) onClose(); }} />}
  </Modal>;
}

export function Models({ notify }: { notify: (message: string) => void }) {
  const models = useData<{ models: Model[] }>('/api/admin/models'); const providers = useData<{ providers: Provider[] }>('/api/admin/providers');
  const users = useData<{ users: PublicUser[] }>('/api/admin/users');
  const [editing, setEditing] = useState<Model | 'new' | null>(null);
  return <div className="page-enter"><div className="page-heading"><div><h1>模型目录</h1><p>发布员工可用的模型，配置接入与分配权重。</p></div><div className="heading-actions"><Refresh busy={models.loading} label="刷新模型配置" onClick={() => { void models.refresh(); void users.refresh(); }} /><Button disabled={!providers.data?.providers.length || !users.data || Boolean(users.error)} onClick={() => setEditing('new')}><Plus size={17} />新增模型</Button></div></div>
    {(models.error || providers.error || users.error) && <Notice error>{models.error || providers.error || users.error}</Notice>}
    {!providers.loading && !providers.data?.providers.length && <Notice>先在“供应商”添加接入，再发布模型。</Notice>}
    {!models.data && models.loading ? <Loading /> : models.data?.models.length ? <div className="admin-model-grid">{models.data.models.map(model => { return <section className="admin-model-card panel" key={model.id}><div className="admin-model-heading"><BrandIcon brand={modelBrand(model.routes)} className="model-symbol" /><div><h2>{model.name}</h2></div><button className="icon-button" disabled={!users.data || Boolean(users.error)} aria-label={`配置 ${model.name}`} onClick={() => setEditing(model)}><Pencil size={17} /></button></div>{model.description && <p className="admin-model-description">{model.description}</p>}<div className="model-property-row"><Status value={model.enabled ? 'enabled' : 'disabled'} label={publicationLabel(model)} /><span className="audience-badge">{audienceLabel(model)}</span></div><div className="route-card-heading"><Layers3 size={15} /><span>动态资源池</span><small>{model.routes.length} 个接入</small></div><div className="model-route-rows">{model.routes.map(r => <div key={r.providerId}><span><BrandIcon brand={providerBrand(providers.data?.providers.find(p => p.id === r.providerId))} className="route-brand" />{providers.data?.providers.find(p => p.id === r.providerId)?.name ?? '接入已移除'}</span><span>权重 {r.weight}</span></div>)}</div><div className="agent-badges">{model.agents.map(a => <span key={a}>{AGENTS.find(x => x.id === a)?.name ?? a}</span>)}</div><button className="panel-link" disabled={!users.data || Boolean(users.error)} onClick={() => setEditing(model)}><SlidersHorizontal size={15} />配置模型与权重<ArrowRight size={15} /></button></section>; })}</div> : <section className="panel"><Empty title="尚未添加模型" detail="填写模型名称、关联接入资源，并选择开放的编程工具。" action={<Button disabled={!providers.data?.providers.length || !users.data || Boolean(users.error)} onClick={() => setEditing('new')}><Plus size={16} />新增模型</Button>} /></section>}
    {editing && <ModelForm model={editing === 'new' ? undefined : editing} providers={providers.data?.providers ?? []} users={users.data?.users ?? []} onClose={() => setEditing(null)} onSaved={message => { void models.refresh(); void users.refresh(); notify(message); }} />}
  </div>;
}
