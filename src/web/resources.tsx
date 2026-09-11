import { useEffect, useRef, useState } from 'react';
import { Box, Trash2, Check, ChevronDown, Pencil, Plus, RefreshCw, Search, ShieldCheck, PlugZap } from 'lucide-react';
import { providerBrand } from '../shared/brand.js';
import { BrandIcon } from './brand-icon.js';
import type { Model, Provider } from '../shared/types.js';
import { api, dateTime } from './api.js';
import { Button, ConfirmAction, Empty, Field, Loading, Modal, Notice, Refresh, Status, useData } from './components.js';
import { errorCodeLabel } from './ui-format.js';
import { Select } from './select.js';

const presets: Record<string, { name: string; product: string; messages?: string; chat?: string }> = {
  zhipu: { name: '智谱', product: 'Coding Plan', messages: 'https://open.bigmodel.cn/api/anthropic', chat: 'https://open.bigmodel.cn/api/coding/paas/v4' },
  volcano: { name: '火山方舟', product: 'Coding Plan', messages: 'https://ark.cn-beijing.volces.com/api/coding', chat: 'https://ark.cn-beijing.volces.com/api/coding/v3' },
  deepseek: { name: 'DeepSeek', product: '按量调用', chat: 'https://api.deepseek.com' },
  bailian: { name: '百炼', product: 'Coding Plan', messages: 'https://coding.dashscope.aliyuncs.com/apps/anthropic', chat: 'https://coding.dashscope.aliyuncs.com/v1' },
};

function ProviderForm({ provider, onClose, onSaved }: { provider?: Provider; onClose: () => void; onSaved: (provider?: Provider, continueSetup?: boolean) => void }) {
  const [presetId, setPresetId] = useState('zhipu');
  const [endpointsOpen, setEndpointsOpen] = useState(Boolean(provider));
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [form, setForm] = useState({
    name: provider?.name ?? presets.zhipu.name, product: provider?.product ?? presets.zhipu.product,
    messages: provider ? provider.endpoints.messages ?? '' : presets.zhipu.messages ?? '',
    chat: provider ? provider.endpoints.chat ?? '' : presets.zhipu.chat ?? '', responses: provider?.endpoints.responses ?? '',
    auth: provider?.auth ?? 'bearer', enabled: provider?.enabled ?? true,
    headers: JSON.stringify(provider?.headers ?? {}, null, 2), defaults: JSON.stringify(provider?.defaults ?? {}, null, 2),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = (key: string, value: unknown) => setForm(f => ({ ...f, [key]: value }));
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const endpoints = Object.fromEntries(['messages', 'chat', 'responses'].map(k => [k, form[k as 'messages'].trim()]).filter(([, value]) => value));
      let headers, defaults;
      try { headers = JSON.parse(form.headers); }
      catch { throw new Error('额外请求头不是有效的 JSON，请检查括号、引号和逗号。'); }
      try { defaults = JSON.parse(form.defaults); }
      catch { throw new Error('请求默认参数不是有效的 JSON，请检查括号、引号和逗号。'); }
      const result = await api<{ provider: Provider }>(`/api/admin/providers${provider ? `/${provider.id}` : ''}`, provider ? 'PUT' : 'POST', {
        name: form.name, product: form.product, endpoints, auth: form.auth, enabled: form.enabled, headers, defaults,
      });
      onSaved(active.current ? result.provider : undefined, active.current && !provider);
    } catch (e) { if (active.current) setError(e instanceof Error ? e.message : '保存失败'); }
    finally { if (active.current) setBusy(false); }
  }
  return <Modal title={provider ? '编辑供应商接入' : '新增供应商接入'} subtitle={provider ? '修改接入名称、接口与连接选项。' : '选择供应商并确认接入名称，下一步填写密钥。'} onClose={onClose} onSubmit={save} wide
    footer={<><Button kind="secondary" type="button" onClick={onClose}>取消</Button><Button busy={busy} type="submit">{provider ? '保存修改' : '下一步：填写密钥'}</Button></>}>
    {error && <Notice error>{error}</Notice>}
    {!provider && <><ol className="setup-steps" aria-label="添加接入步骤"><li aria-current="step"><span>1</span>设置接入</li><li><span>2</span>填写密钥</li></ol>
      <Field label="供应商"><Select value={presetId} onValueChange={value => {
        setPresetId(value); setEndpointsOpen(value === 'custom');
        const preset = presets[value];
        setForm(f => ({ ...f, name: preset?.name ?? '', product: preset?.product ?? '', messages: preset?.messages ?? '', chat: preset?.chat ?? '', responses: '', auth: 'bearer' }));
      }} options={[
        { value: 'zhipu', label: '智谱编程套餐', description: '团队与个人套餐' },
        { value: 'volcano', label: '火山方舟编程套餐', description: '火山方舟平台' },
        { value: 'deepseek', label: 'DeepSeek 按量调用', description: '使用官方接口' },
        { value: 'bailian', label: '百炼编程套餐', description: '阿里云百炼平台' },
        { value: 'custom', label: '自定义供应商', description: '手动填写兼容接口' },
      ]} /></Field></>}
    <div className="form-grid">
      <Field label="接入名称"><input value={form.name} required onChange={e => update('name', e.target.value)} placeholder="例如：智谱" /></Field>
      <Field label="产品或套餐"><input value={form.product} onChange={e => update('product', e.target.value)} placeholder="例如：团队标准版编程套餐" /></Field>
    </div>
    <details className="advanced connection-settings" open={endpointsOpen} onToggle={e => setEndpointsOpen(e.currentTarget.open)}>
      <summary><span>接口设置<small>{!provider && presetId !== 'custom' ? '已填入默认接口，通常无需调整。' : '设置接口地址、身份验证与接入状态。'}</small></span><ChevronDown size={16} /></summary>
    <Field label="Claude 消息接口地址" hint="用于 Claude Code 原生调用，填写接口的服务根地址。"><input type="url" value={form.messages} onChange={e => update('messages', e.target.value)} placeholder="https://…/anthropic" /></Field>
    <Field label="通用对话接口地址" hint="网关可将此接口转换为 Claude Code、Codex 与 ZCode 所需的协议。"><input type="url" value={form.chat} onChange={e => update('chat', e.target.value)} placeholder="https://…/v1" /></Field>
    <Field label="Codex 响应接口地址（可选）" hint="供应商支持原生响应接口时填写；否则使用通用对话接口。"><input type="url" value={form.responses} onChange={e => update('responses', e.target.value)} placeholder="https://…/v1" /></Field>
    <div className="form-grid provider-auth-grid">
      <Field label="身份验证方式"><Select value={form.auth} onValueChange={value => update('auth', value)} options={[{ value: 'bearer', label: '标准令牌认证' }, { value: 'x-api-key', label: '密钥请求头认证' }]} /></Field>
      <div className="field"><span>接入状态</span><label className="check-field check-control"><input type="checkbox" checked={form.enabled} onChange={e => update('enabled', e.target.checked)} />启用接入</label></div>
    </div>
    </details>
    <details className="advanced"><summary><span>高级设置（可选）<small>自定义请求头与默认参数，使用预设时保持默认即可。</small></span><ChevronDown size={16} /></summary>
      <Field label="额外请求头（JSON）" hint="仅用于供应商要求的额外兼容信息。供应商密钥由资源池统一管理。"><textarea rows={3} value={form.headers} onChange={e => update('headers', e.target.value)} /></Field>
      <Field label="请求默认参数（JSON）" hint="为请求补充默认选项；保持 {} 即可使用默认行为。"><textarea rows={3} value={form.defaults} onChange={e => update('defaults', e.target.value)} /></Field>
    </details>
    {provider && <ConfirmAction path={`/api/admin/providers/${provider.id}`} label="删除接入" detail="确认删除此接入？仍关联模型或密钥时无法删除。历史调用记录保留。" onDone={() => { onSaved(); if (active.current) onClose(); }} />}
  </Modal>;
}

function KeyForm({ providers, current, defaultProvider, setupProvider, onClose, onSaved }: { providers: Provider[]; current?: any; defaultProvider: string; setupProvider?: Provider; onClose: () => void; onSaved: () => void }) {
  const modelCatalog = useData<{ models: Model[] }>('/api/admin/models');
  const [restrictModels, setRestrictModels] = useState(Boolean(current?.models?.length));
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [form, setForm] = useState({
    providerId: current?.providerId ?? (setupProvider?.id || defaultProvider || providers[0]?.id || ''), name: current?.name ?? setupProvider?.name ?? '', secret: '',
    maxConcurrent: current?.maxConcurrent ?? 1, weight: current?.weight ?? 1, rateScope: current?.rateScope ?? 'key',
    group: current?.group ?? '', enabled: current?.enabled ?? true, models: (current?.models ?? []) as string[],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = (key: string, value: unknown) => setForm(f => ({ ...f, [key]: value }));
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      if (restrictModels && !form.models.length) throw new Error('请选择至少一个可用模型，或改为允许全部已关联模型。');
      const base = {
        name: form.name, models: restrictModels ? form.models : [],
        maxConcurrent: Number(form.maxConcurrent), weight: Number(form.weight), rateScope: form.rateScope, group: form.group,
      };
      if (current) await api(`/api/admin/keys/${current.id}`, 'PUT', { ...base, providerId: form.providerId, enabled: form.enabled, ...(form.secret.trim() ? { secret: form.secret.trim() } : {}) });
      else {
        const keys = form.secret.split(/\r?\n/).map(key => key.trim()).filter(Boolean);
        if (!keys.length) throw new Error('请粘贴至少一把供应商密钥。');
        await api('/api/admin/keys', 'POST', {
          keys: keys.map((secret, index) => ({ ...base, providerId: form.providerId, name: keys.length > 1 ? `${form.name}-${String(index + 1).padStart(2, '0')}` : form.name, secret })),
        });
      }
      onSaved(); if (active.current) onClose();
    } catch (e) { if (active.current) setError(e instanceof Error ? e.message : '保存失败'); }
    finally { if (active.current) setBusy(false); }
  }
  return <Modal title={current ? '编辑调用密钥' : setupProvider ? '填写供应商密钥' : '添加调用密钥'} subtitle={current ? '替换供应商密钥后，员工仍使用现有公司访问凭证。' : setupProvider ? `${setupProvider.name}接入已保存。粘贴供应商后台生成的密钥。` : '支持批量添加，完整密钥仅加密保存在公司服务端。'} onClose={onClose} onSubmit={save}
    footer={<><Button type="button" kind="secondary" onClick={onClose}>{setupProvider ? '稍后添加' : '取消'}</Button><Button type="submit" busy={busy}><Check size={16} />{current ? '保存修改' : '添加密钥'}</Button></>}>
    {error && <Notice error>{error}</Notice>}
    {setupProvider && <><ol className="setup-steps" aria-label="添加接入步骤"><li className="complete"><span><Check size={12} /></span>设置接入</li><li aria-current="step"><span>2</span>填写密钥</li></ol><div className="setup-provider"><Box size={19} /><span>所属接入<strong>{setupProvider.name}</strong></span></div></>}
    {!setupProvider && <Field label="所属接入" hint={current ? "请确认此密钥适用于目标接入；更换归属不会转换密钥所属套餐。" : undefined}><Select required value={form.providerId} onValueChange={value => setForm(f => ({ ...f, providerId: value }))} placeholder="选择供应商接入" options={providers.map(provider => ({ value: provider.id, label: `${provider.name} · ${provider.product}` }))} /></Field>}
    <Field label="密钥名称" hint="批量添加时会自动追加编号。"><input required value={form.name} onChange={e => update('name', e.target.value)} placeholder="例如：智谱团队" /></Field>
    <Field label={current ? '替换密钥（留空保留现有值）' : '供应商密钥'} hint={current ? `当前密钥：${current.hint}` : '每行一把密钥，保存后只显示脱敏尾号。'}><textarea rows={current ? 2 : 4} required={!current} value={form.secret} onChange={e => update('secret', e.target.value)} autoComplete="off" spellCheck={false} placeholder={current ? '粘贴新的供应商密钥' : '粘贴供应商密钥，每行一条'} /></Field>
    <details className="advanced"><summary><span>使用与限流设置（可选）<small>调整并发、分配权重和模型范围。</small></span><ChevronDown size={16} /></summary>
    <div className="form-grid">
      <Field label="最大同时请求数"><input type="number" min={1} max={100} value={form.maxConcurrent} onChange={e => update('maxConcurrent', e.target.value)} /></Field>
      <Field label="池内权重"><input type="number" min={0.01} step={0.01} value={form.weight} onChange={e => update('weight', e.target.value)} /></Field>
    </div>
      <Field label="限流状态共享范围"><Select value={form.rateScope} onValueChange={value => update('rateScope', value)} options={[{ value: 'key', label: '整把密钥' }, { value: 'model', label: '同一密钥内按模型区分' }, { value: 'group', label: '多把密钥共享限流组' }]} /></Field>
      {form.rateScope === 'group' && <Field label="共享组名称"><input required value={form.group} onChange={e => update('group', e.target.value)} /></Field>}
      <Field label="可用模型范围"><Select value={restrictModels ? 'selected' : 'all'} onValueChange={value => setRestrictModels(value === 'selected')} options={[{ value: 'all', label: '全部已关联模型' }, { value: 'selected', label: '仅允许指定模型' }]} /></Field>
      {restrictModels && <div className="key-model-scope">{modelCatalog.error && <Notice error>{modelCatalog.error}</Notice>}{modelCatalog.loading && !modelCatalog.data ? <Loading /> : <div className="model-permissions">{modelCatalog.data?.models.filter(model => form.models.includes(model.id) || model.routes.some(route => route.providerId === form.providerId)).map(model => <label className="permission-option" key={model.id}><input type="checkbox" checked={form.models.includes(model.id)} onChange={e => update('models', e.target.checked ? [...form.models, model.id] : form.models.filter(id => id !== model.id))} /><span>{model.name}</span>{!model.routes.some(route => route.providerId === form.providerId) && <small>未关联此供应商</small>}</label>)}</div>}{modelCatalog.data && !modelCatalog.data.models.some(model => model.routes.some(route => route.providerId === form.providerId)) && <p className="small-note">先在模型目录关联此供应商，再指定模型范围。</p>}{form.models.some(id => !modelCatalog.data?.models.some(model => model.id === id)) && modelCatalog.data && <button className="text-button" type="button" onClick={() => update('models', form.models.filter(id => modelCatalog.data!.models.some(model => model.id === id)))}>清除已移除模型的限制</button>}</div>}
    </details>
    {current && <label className="check-field"><input type="checkbox" checked={form.enabled} onChange={e => update('enabled', e.target.checked)} />启用此密钥</label>}
    {current && <ConfirmAction path={`/api/admin/keys/${current.id}`} label="删除密钥" detail="删除后将停止使用此密钥，需重新录入才能恢复。有请求运行时无法删除。历史调用记录保留。" onDone={() => { onSaved(); if (active.current) onClose(); }} />}
  </Modal>;
}

function ConnectionCheck({ item, onClose, onDone }: { item: any; onClose: () => void; onDone: () => void }) {
  const models = useData('/api/admin/models');
  const [modelId, setModel] = useState('');
  const [agent, setAgent] = useState('claude-code');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<any>(null);
  const options = models.data?.models.filter((model: any) => model.enabled && model.routes.some((route: any) => route.providerId === item.providerId) && (!item.models.length || item.models.includes(model.id))) ?? [];
  async function check(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(''); setResult(null);
    try {
      const value = await api(`/api/admin/keys/${item.id}/check`, 'POST', { modelId, agent });
      setResult(value); onDone();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <Modal title={`验证 ${item.name}`} subtitle="发送一次简短请求，将计入供应商套餐用量。" onClose={onClose} onSubmit={check}
    footer={<><Button kind="secondary" type="button" onClick={onClose}>关闭</Button><Button type="submit" busy={busy} disabled={!modelId || models.loading}><PlugZap size={16} />验证连接</Button></>}>
    {(error || models.error) && <Notice error>{error || models.error}</Notice>}
    {result && <Notice error={!result.ok}>{result.message}<br />请求编号：{result.requestId}</Notice>}
    <Field label="已发布模型"><Select required value={modelId} onValueChange={setModel} disabled={models.loading || !options.length} placeholder={models.loading ? '正在加载模型…' : options.length ? '选择要验证的模型' : '暂无可验证的模型'} options={options.map((model: any) => ({ value: model.id, label: model.name }))} /></Field>
    {!models.loading && !models.error && !options.length && <Notice>请先在模型目录发布关联此接入的模型，并检查密钥的模型范围。</Notice>}
    <Field label="验证工具"><Select value={agent} onValueChange={setAgent} options={[{ value: 'claude-code', label: 'Claude Code' }, { value: 'zcode', label: 'ZCode' }, { value: 'codex-cli', label: 'Codex 命令行' }, { value: 'codex-desktop', label: 'Codex 桌面版' }]} /></Field>
    <p className="small-note">冷却或隔离中的密钥会继续受保护。确认供应商已恢复后，可先在资源表中清除隔离状态，再验证连接。</p>
  </Modal>;
}

export function Resources({ notify, mode = 'keys', initialProvider = 'all', onProviderChange, onViewKeys, onProviders }: { notify: (message: string) => void; mode?: 'keys' | 'providers'; initialProvider?: string; onProviderChange?: (id: string) => void; onViewKeys?: (id: string) => void; onProviders?: () => void }) {
  const providers = useData<{ providers: Provider[] }>('/api/admin/providers');
  const keys = useData('/api/admin/keys', mode === 'keys' ? 2000 : 0);
  const [selected, setSelected] = useState(initialProvider);
  useEffect(() => { onProviderChange?.(selected); }, [selected, onProviderChange]);
  const [deleting, setDeleting] = useState<{ path: string; name: string; provider: boolean } | null>(null);
  const [query, setQuery] = useState('');
  const [providerForm, setProviderForm] = useState<Provider | 'new' | null>(null);
  const [keyForm, setKeyForm] = useState<any | 'new' | null>(null);
  const [setupProvider, setSetupProvider] = useState<Provider | undefined>();
  const [error, setError] = useState('');
  const [checking, setChecking] = useState<any>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const allProviders = providers.data?.providers ?? [];
  const allKeys = keys.data?.keys ?? [];
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = allKeys.filter((key: any) => (selected === 'all' || key.providerId === selected) && `${key.name} ${key.hint}`.toLowerCase().includes(normalizedQuery));
  const loading = providers.loading || keys.loading;
  const providerName = (id: string) => allProviders.find(provider => provider.id === id)?.name ?? '未知接入';
  useEffect(() => {
    if (providers.data && selected !== 'all' && !providers.data.providers.some(provider => provider.id === selected)) setSelected('all');
  }, [providers.data, selected]);
  async function refresh() {
    setError('');
    return Promise.all([providers.refresh(), keys.refresh()]);
  }
  function saved() { void refresh(); notify('资源配置已保存'); }
  function providerSaved(created?: Provider, continueSetup = false) {
    void refresh();
    if (continueSetup && created) {
      setProviderForm(null); setSelected('all'); setQuery('');
      setSetupProvider(created); setKeyForm('new');
      notify('接入已保存，请继续填写供应商密钥');
    } else {
      // A late response can refresh the list but must not reopen a dismissed flow.
      if (created) setProviderForm(null);
      notify('接入配置已保存');
    }
  }
  function closeKeyForm() {
    setKeyForm(null); setSetupProvider(undefined);
    requestAnimationFrame(() => {
      const addKey = document.getElementById('add-provider-key') as HTMLButtonElement | null;
      (addKey && !addKey.disabled ? addKey : document.getElementById('add-provider'))?.focus({ preventScroll: true });
    });
  }
  async function resetKey(key: any) {
    setResetting(key.id); setError('');
    try {
      await api(`/api/admin/keys/${key.id}/reset`, 'POST');
      await refresh(); notify('已清除隔离状态，后续请求将重新检查此密钥');
    } catch (e) { setError((e as Error).message); }
    finally { setResetting(null); }
  }
  return <div className="page-enter resources-page">
    {deleting && <Modal title={`删除${deleting.provider ? '接入' : '密钥'}：${deleting.name}`} onClose={() => setDeleting(null)}>
      <p>{deleting.provider ? '关联模型或密钥的接入不能删除，请先解除关联。' : '删除后立即停止调度此密钥；有请求运行时请等待结束后再删除。'}历史调用记录保留。</p>
      <ConfirmAction initialConfirm path={deleting.path} label={deleting.provider ? '删除接入' : '删除密钥'} detail="请确认删除此项配置。" onDone={() => { setDeleting(null); void refresh(); notify('已删除'); }} />
    </Modal>}
    <div className="page-heading"><div><h1>{mode === 'providers' ? '供应商' : '密钥池'}</h1><p>{mode === 'providers' ? '管理供应商接口与套餐，每种套餐单独配置接入。' : '管理调用密钥、所属接入与并发状态。'}</p></div><div className="heading-actions">
      {mode === 'providers' && <Refresh label="刷新供应商" busy={loading} onClick={() => void refresh()} />}
      {mode === 'providers' && <Button id="add-provider" onClick={() => setProviderForm('new')}><Plus size={17} />新增供应商</Button>}
      {mode === 'keys' && <Button id="add-provider-key" disabled={!allProviders.length} onClick={() => { setSetupProvider(undefined); setKeyForm('new'); }}><Plus size={17} />添加密钥</Button>}
    </div></div>
    {(error || providers.error || keys.error) && <Notice error>{error || providers.error || keys.error}</Notice>}
    {mode === 'keys' && keys.data && <p className="small-note" role="status">当前请求 {keys.data.live?.active ?? '—'} · 排队 {keys.data.queued ?? '—'} · 近 5 分钟并发峰值 {keys.data.live?.peak ?? '—'} · {keys.error ? '刷新失败，以下为上次数据' : '每 2 秒自动刷新'} · 更新于 {new Date(keys.data.updatedAt).toLocaleTimeString('zh-CN')}<br />并发峰值从本次服务启动后记录；请求结束后当前请求数会回到 0。</p>}
    {mode === 'providers' && <section className="panel providers-panel">
      {loading && !providers.data ? <Loading /> : !providers.data ? <Empty title="供应商未能加载" detail="请刷新重试。" action={<Refresh busy={loading} onClick={() => void refresh()} />} /> : !allProviders.length ? <Empty title="尚未添加供应商" detail="先配置供应商接口，再添加密钥。" action={<Button onClick={() => setProviderForm('new')}>新增供应商</Button>} /> : <div className="table-scroll"><table className="provider-table">
        <thead><tr><th>供应商接入</th><th>产品 / 套餐</th><th>密钥</th><th>状态</th><th className="right">操作</th></tr></thead>
        <tbody>{allProviders.map(provider => <tr key={provider.id}>
          <td><span className="provider-table-name"><BrandIcon brand={providerBrand(provider)} className="route-brand" /><strong>{provider.name}</strong></span></td><td>{provider.product}</td>
          <td><button type="button" className="text-button" onClick={() => onViewKeys?.(provider.id)}>{keys.data ? allKeys.filter((key: any) => key.providerId === provider.id).length : '—'} 把 · 查看密钥</button></td>
          <td><Status value={provider.enabled ? 'enabled' : 'disabled'} /></td>
          <td><div className="row-actions"><Button kind="quiet" onClick={() => { setSelected(provider.id); setSetupProvider(undefined); setKeyForm('new'); }}>添加密钥</Button><button type="button" className="icon-button" aria-label={`编辑 ${provider.name} 接入`} title="编辑接入" onClick={() => setProviderForm(provider)}><Pencil size={18} /></button><button type="button" className="icon-button" aria-label={`删除 ${provider.name} 接入`} title="删除接入" onClick={() => setDeleting({ path: `/api/admin/providers/${provider.id}`, name: provider.name, provider: true })}><Trash2 size={17} /></button></div></td>
        </tr>)}</tbody>
      </table></div>}
    </section>}
    {mode === 'keys' && <>
    <section className="panel resources-panel">
      <div className="panel-heading"><div><h2>调用密钥<span className="count">{filtered.length}</span></h2>{selected !== 'all' && <p>{providerName(selected)}</p>}</div><div className="table-tools">
        <Select label="筛选供应商" value={selected} onValueChange={setSelected} options={[{ value: 'all', label: '全部供应商' }, ...allProviders.map(p => ({ value: p.id, label: p.name }))]} /><div className="search-input"><Search size={17} /><input aria-label="搜索调用密钥" placeholder="搜索名称或尾号" value={query} onChange={e => setQuery(e.target.value)} /></div>
        <Refresh label="刷新供应商与密钥" busy={loading} onClick={() => void refresh()} />
      </div></div>
      {(!keys.data || !providers.data) && loading ? <Loading /> : !keys.data || !providers.data ? <Empty title="资源未能加载" detail="请检查服务连接后重试。" action={<Button kind="secondary" onClick={() => void refresh()}>重新加载</Button>} /> : filtered.length ? <div className="table-scroll"><table className="resource-table">
        <thead><tr><th>名称</th><th>所属接入</th><th>密钥</th><th>当前请求 / 并发上限</th><th>最近成功</th><th>状态</th><th className="right">操作</th></tr></thead>
        <tbody>{filtered.map((key: any) => {
          const block = key.states.find((entry: any) => entry.state)?.state;
          const recoveryPending = key.states.some((entry: any) => entry.recoveryPending);
          const provider = allProviders.find(item => item.id === key.providerId);
          const state = !key.enabled || !provider?.enabled ? 'disabled' : block ? String(block.scope).startsWith('invalid:') ? 'error' : 'cooldown' : key.inFlight >= key.maxConcurrent ? 'busy' : recoveryPending ? 'unknown' : key.lastSuccess ? 'available' : 'unknown';
          return <tr key={key.id}>
            <td><div className="key-name"><strong>{key.name}</strong></div></td>
            <td>{providerName(key.providerId)}</td><td className="mono muted">{key.hint}</td>
            <td className="tabular">{key.inFlight} <span className="muted">/ {key.maxConcurrent}</span></td><td className="muted">{dateTime(key.lastSuccess)}</td>
            <td><Status value={state} label={state === 'error' ? '密钥异常' : state === 'unknown' && recoveryPending ? '待重试' : undefined} />{block && state !== 'disabled' && <small className="cell-caption" title={block.reason}>{state === 'cooldown' ? ` ${errorCodeLabel(block.reason)} · 约 ${Math.max(0, Math.ceil((block.until_ms - Date.now()) / 1000))} 秒后可重试` : '请更新密钥'}</small>}</td>
            <td><div className="row-actions">
              <button type="button" className="icon-button" aria-label={`删除 ${key.name}`} title="删除密钥" onClick={() => setDeleting({path: `/api/admin/keys/${key.id}`, name: key.name, provider: false})}><Trash2 size={17} /></button>
              <button type="button" className="icon-button" aria-label={`编辑 ${key.name}`} title="编辑密钥" onClick={() => setKeyForm(key)}><Pencil size={18} /></button>
              <button type="button" className="icon-button" aria-label={`验证 ${key.name}`} title="验证连接" onClick={() => setChecking(key)}><PlugZap size={18} /></button>
              <button type="button" className="icon-button" aria-label={`清除 ${key.name} 的隔离状态`} title="清除隔离状态" disabled={resetting !== null} onClick={() => void resetKey(key)}><RefreshCw size={18} className={resetting === key.id ? 'spin' : ''} /></button>
            </div></td>
          </tr>;
        })}</tbody>
      </table></div> : normalizedQuery ? <Empty title="没有找到匹配的密钥" detail="试试其他名称或尾号，也可以清除搜索条件。" action={<Button kind="secondary" onClick={() => setQuery('')}>清除搜索</Button>} /> : <Empty
        title={!allProviders.length ? '添加第一个供应商接入' : selected !== 'all' ? '该接入尚未添加密钥' : '尚未添加调用密钥'}
        detail={!allProviders.length ? '选择供应商、填写接口地址，再添加调用密钥。' : '录入供应商密钥后，可在模型目录中设置模型路由。'}
        action={<Button kind="secondary" onClick={() => allProviders.length ? setKeyForm('new') : onProviders?.()}><Plus size={17} />{allProviders.length ? '添加密钥' : '新增接入'}</Button>} />}
    </section>
    <p className="resource-security-note"><ShieldCheck size={16} />密钥加密保存在服务端，员工使用独立的公司访问凭证。</p></>}
    {providerForm && <ProviderForm provider={providerForm === 'new' ? undefined : providerForm} onClose={() => setProviderForm(null)} onSaved={providerSaved} />}
    {keyForm && <KeyForm providers={setupProvider && !allProviders.some(provider => provider.id === setupProvider.id) ? [...allProviders, setupProvider] : allProviders} current={keyForm === 'new' ? undefined : keyForm} setupProvider={setupProvider} defaultProvider={selected === 'all' ? allProviders[0]?.id ?? '' : selected} onClose={closeKeyForm} onSaved={saved} />}
    {checking && <ConnectionCheck item={checking} onClose={() => setChecking(null)} onDone={() => void refresh()} />}
  </div>;
}
