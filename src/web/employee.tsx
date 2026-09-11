import { useEffect, useState } from 'react';
import { Check, ChevronRight, Copy, FolderOpen, History, Image, Info, Monitor, Play, Terminal, Wrench } from 'lucide-react';
import type { AgentId, EmployeeModel } from '../shared/types.js';
import { AGENTS, isDesktopAgent, matchesAgent } from '../shared/types.js';
import { APP_VERSION } from '../shared/version.js';
import { api, copyText, dateTime, desktop, type DesktopState, type Inspection } from './api.js';
import { Button, Empty, Loading, Modal, Notice, Refresh, Status, useData } from './components.js';
import { errorCodeLabel, statusLabel } from './ui-format.js';
import { BrandIcon } from './brand-icon.js';
import { AutomaticUpgradeNotice } from './legacy-migration.js';

export function Employee({ notify }: { notify: (message: string) => void }) {
  const [agent, setAgent] = useState<AgentId>('claude-code');
  const { data, error, loading, refresh } = useData<{ models: EmployeeModel[] }>(`/api/models?agent=${agent}`);
  const [state, setState] = useState<DesktopState | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [busy, setBusy] = useState('');
  const [failure, setFailure] = useState('');
  const [copying, setCopying] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [details, setDetails] = useState<EmployeeModel | null>(null);
  const [verification, setVerification] = useState<any>(null);
  const applied = state?.configured[agent];
  const defaultUnavailable = Boolean(applied && data && !loading && !error && !data.models.some(model => model.id === applied.modelId));
  useEffect(() => {
    const reload = () => { void refresh(); };
    const visible = () => { if (document.visibilityState === 'visible') reload(); };
    window.addEventListener('focus', reload); document.addEventListener('visibilitychange', visible);
    return () => { window.removeEventListener('focus', reload); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);
  const toolName = AGENTS.find(a => a.id === agent)!.name;
  const isApplied = (model: EmployeeModel) => Boolean(applied?.modelId === model.id && !applied.needsUpdate);
  const matchedVerification = verification?.model_id === applied?.modelId && matchesAgent(verification?.agent, agent) ? verification : null;
  const latestAppliedRequest = async () => applied ? (await api(`/api/me/credential-status?credentialId=${encodeURIComponent(applied.credentialId)}&since=${applied.appliedAt}&modelId=${encodeURIComponent(applied.modelId)}&agent=${agent}`)).request : null;
  const verify = async () => { setVerification(await latestAppliedRequest()); };
  useEffect(() => {
    setVerification(null); if (!applied) return;
    void verify().catch(() => {});
    const timer = setInterval(() => void verify().catch(() => {}), 30_000);
    return () => clearInterval(timer);
  }, [agent, applied?.credentialId, applied?.appliedAt]);
  const reloadState = async () => {
    if (desktop) { setState(await desktop.getState()); setInspection(await desktop.inspect(agent)); }
  };
  useEffect(() => {
    setInspection(null);
    const bridge = desktop; if (!bridge) return;
    let active = true;
    const load = async () => {
      try {
        const nextState = await bridge.getState(); if (active) setState(nextState);
        const nextInspection = await bridge.inspect(agent); if (active) setInspection(nextInspection);
      } catch (e) { if (active) setFailure(e instanceof Error ? e.message : '无法读取本地配置'); }
    };
    void load(); window.addEventListener('focus', load);
    return () => { active = false; window.removeEventListener('focus', load); };
  }, [agent]);
  async function action(name: string, fn: () => Promise<void>) {
    setBusy(name); setFailure('');
    try { await fn(); } catch (e) { setFailure(e instanceof Error ? e.message : '操作失败'); }
    finally {
      try { await reloadState(); } catch (e) { setFailure(previous => previous || (e instanceof Error ? e.message : '无法读取本地配置')); }
      setBusy('');
    }
  }
  const applyModel = (model: EmployeeModel) => action(`apply:${model.id}`, async () => {
    const result = await desktop!.apply(agent, model.id);
    if (result.changed === false) { notify(`当前配置已是 ${model.name}，无需重启 ${toolName}`); return; }
    notify(agent === 'zcode' ? `${model.name} 已添加，请重开 ZCode 并在模型选择器中选择 Coding Access` : `已启用 ${model.name}，新会话将使用此模型`);
  });
  const launchModel = (model: EmployeeModel) => action(`launch:${model.id}`, async () => {
    if (isDesktopAgent(agent) && !isApplied(model)) throw new Error(`请先启用 ${model.name}，再打开工具`);
    if (!isDesktopAgent(agent) && !state?.projectDirectory && !await desktop!.chooseDirectory()) return;
    await desktop!.launch(agent, model.id);
    notify(isDesktopAgent(agent) ? '已请求打开桌面应用' : `已打开 ${model.name} 的临时会话，默认模型未更改`);
  });
  const copyDiagnostics = async () => {
    setCopying(true);
    try {
      let latest = null; let lookupError = '';
      try { latest = await latestAppliedRequest(); } catch (e) { lookupError = e instanceof Error ? e.message : '无法获取最近调用'; }
      const diagnostics = { time: new Date().toISOString(), agent, model: applied?.modelId ?? null, appVersion: state?.version ?? APP_VERSION, platform: state?.platform ?? 'browser', toolVersion: inspection?.version ?? 'unknown', error: failure || error || latest?.error_code || '', requestId: latest?.id ?? null, checks: inspection?.warnings ?? [], ...(lookupError ? { requestLookupError: lookupError } : {}) };
      await copyText(JSON.stringify(diagnostics, null, 2)); notify(lookupError ? '已复制本地诊断信息，暂未取得最近调用记录' : '已复制诊断信息，可交给管理员定位问题');
    } finally { setCopying(false); }
  };
  return <div className="employee-page page-enter client-focus">
    <div className="page-heading client-heading">
      <div><h1>开始编程</h1><p>启用团队模型，在编程工具的新会话中使用。</p></div>
      <div className="agent-tabs" role="tablist" aria-label="编程工具">{AGENTS.map(a => <button role="tab" aria-selected={a.id === agent} className={agent === a.id ? 'active' : ''} key={a.id} disabled={Boolean(busy)} onClick={() => { setAgent(a.id); setFailure(''); }}>{isDesktopAgent(a.id) ? <Monitor size={16} /> : <Terminal size={16} />}<span>{a.name}</span></button>)}</div>
    </div>
    {(failure || error) && <Notice error>{failure || error}</Notice>}
    {defaultUnavailable && <Notice>当前默认模型「{applied?.modelName}」已不可用，可能已下架、调整使用范围或不再对当前工具开放。请选择其他模型；本地默认配置尚未更改。</Notice>}
    {!desktop && <Notice>请使用 Windows 或 macOS 客户端配置编程工具、选择项目并打开终端。</Notice>}
    {desktop && inspection && !inspection.installed && <Notice warning>未检测到 {toolName}，请先安装工具。</Notice>}
    <div className="client-toolbar">
      <button className="project-directory" disabled={!desktop || Boolean(busy)} onClick={() => void action('directory', async () => { await desktop!.chooseDirectory(); })} title={state?.projectDirectory || '选择项目文件夹'}><FolderOpen size={18} /><span><small>项目目录</small><strong>{state?.projectDirectory || '选择项目文件夹'}</strong></span><ChevronRight size={16} /></button>
      <div className="client-toolbar-actions"><Refresh busy={loading || Boolean(busy)} label="刷新模型列表" onClick={() => void action('refresh', async () => { if (await refresh()) notify('模型列表刷新完成'); })} /><button className="button secondary" disabled={Boolean(busy)} onClick={() => setDiagnosticsOpen(true)}><Wrench size={16} />排查问题</button></div>
    </div>
    <section className="client-model-list" aria-label={`${toolName} 可用模型`}>
      {loading && !data ? <Loading /> : data?.models.length ? data.models.map(model => {
        const current = isApplied(model);
        const needsUpdate = applied?.modelId === model.id && applied.needsUpdate;
        const launchLabel = isDesktopAgent(agent) ? '打开桌面应用' : '在终端中打开';
        const launchTitle = !desktop ? '请使用桌面客户端' : isDesktopAgent(agent) ? !current ? `请先${needsUpdate ? '同步' : '启用'} ${model.name}` : `${launchLabel} · ${model.name}` : `${state?.projectDirectory ? '在终端中打开' : '选择项目文件夹并打开'} ${model.name}（仅本次会话，不改变默认模型）`;
        return <article key={model.id} data-model-id={model.id} className={`client-model-row ${current ? 'is-applied' : ''}`}>
          <BrandIcon brand={model.brand} className="client-model-symbol" />
          <div className="client-model-copy"><h2>{model.name}</h2><div className="client-model-meta"><Status value={model.status} />{model.vision && <span className="client-vision"><Image size={13} />支持图片</span>}{model.description?.trim() && <span className="client-model-description">{model.description}</span>}</div></div>
          <div className="client-row-actions">
            <Button className={`model-enable ${current ? 'applied-button' : ''}`} disabled={!desktop || !state || Boolean(busy) || current} busy={busy === `apply:${model.id}`} title={current ? '当前默认模型' : needsUpdate ? '同步默认配置' : '设为默认模型'} aria-label={`${current ? '使用中' : needsUpdate ? '同步' : '启用'} ${model.name}`} onClick={() => void applyModel(model)}>{current ? <Check size={15} /> : <Play size={15} />}{current ? '使用中' : needsUpdate ? '同步' : '启用'}</Button>
            <span className="row-action-divider" aria-hidden="true" />
            <span className="shortcut-wrap" title={launchTitle}><button className="icon-button row-shortcut" disabled={!desktop || !state || (isDesktopAgent(agent) && !current) || Boolean(busy)} aria-label={`${launchLabel} ${model.name}`} onClick={() => void launchModel(model)}>{isDesktopAgent(agent) ? <Monitor size={19} /> : <Terminal size={19} />}</button></span>
            <button className="icon-button row-shortcut" disabled={Boolean(busy)} title="模型详情" aria-label={`${model.name} 模型详情`} onClick={() => setDetails(model)}><Info size={19} /></button>
          </div>
        </article>;
      }) : <Empty title="暂未开放模型" detail="管理员发布到你的使用范围后，刷新即可查看。" />}
    </section>
    <p className="client-list-hint">{isDesktopAgent(agent) ? '点击「启用」切换默认模型，再用右侧快捷按钮打开应用。已打开的会话不会自动切换。' : '「启用」设置默认模型；终端按钮仅为新会话使用该行模型，无需启用，也不改变默认模型或其他会话。'}</p>
    {agent === 'zcode' && <Notice>配置相同时无需重开 ZCode。切换接入配置后，在 ZCode 模型选择器中选择 Coding Access 下的模型。</Notice>}
    {details && <Modal title={details.name} subtitle="模型详情" onClose={() => setDetails(null)} footer={<Button kind="secondary" onClick={() => setDetails(null)}>关闭</Button>}><dl className="client-detail-fields"><div><dt>可用状态</dt><dd><Status value={details.status} /></dd></div>{details.description?.trim() && <div><dt>说明</dt><dd>{details.description}</dd></div>}{details.vision !== undefined && <div><dt>图片输入</dt><dd>{details.vision ? '支持' : '不支持'}</dd></div>}{details.contextWindow != null && <div><dt>上下文容量</dt><dd>{details.contextWindow.toLocaleString('zh-CN')} 词元</dd></div>}{details.maxOutputTokens != null && <div><dt>单次输出上限</dt><dd>{details.maxOutputTokens.toLocaleString('zh-CN')} 词元</dd></div>}</dl></Modal>}
    {diagnosticsOpen && <Modal title={`${toolName} · 排查问题`} onClose={() => setDiagnosticsOpen(false)} footer={<Button kind="secondary" onClick={() => setDiagnosticsOpen(false)}>关闭</Button>}>
      {failure && <Notice error>{failure}</Notice>}
      <AutomaticUpgradeNotice disabled={Boolean(busy)} onChecked={() => { void reloadState(); }} />
      {inspection?.warnings.map(w => <Notice key={w}>{w}</Notice>)}
      <dl className="client-detail-fields"><div><dt>客户端版本</dt><dd>{state?.version ?? APP_VERSION}</dd></div><div><dt>工具版本</dt><dd>{inspection?.version || (inspection?.installed ? '已安装，版本未知' : '未检测到')}</dd></div><div><dt>已应用模型</dt><dd>{applied?.modelName ?? '尚未应用'}</dd></div>{applied && <div><dt>配置保存时间</dt><dd>{dateTime(applied.appliedAt)}</dd></div>}</dl>
      {applied && <div className={`client-verification ${matchedVerification && matchedVerification.status !== 'success' ? 'has-error' : ''}`}><p>{matchedVerification ? matchedVerification.status === 'success' ? '网关已收到成功调用。' : `最近调用：${matchedVerification.error_code ? errorCodeLabel(matchedVerification.error_code) : statusLabel(matchedVerification.status)}` : '尚未收到调用，请在工具中新建会话。'}</p><button className="text-button" disabled={Boolean(busy)} onClick={() => void action('verify', verify)}>{busy === 'verify' ? '正在检查…' : '检查最近调用'}</button></div>}
      <div className="client-diagnostic-actions"><Button kind="secondary" busy={copying} disabled={Boolean(busy)} onClick={() => void copyDiagnostics().catch(e => setFailure(e.message))}><Copy size={14} />复制诊断信息</Button>{desktop && applied && <><button className="text-button" disabled={Boolean(busy) || defaultUnavailable} onClick={() => void action('sync', async () => { const result = await desktop!.apply(agent, applied.modelId); notify(result.changed === false ? `当前配置一致，无需重启 ${toolName}` : isDesktopAgent(agent) ? `已更新配置，请打开 ${toolName}` : '已同步当前配置，请在新会话中使用'); })}>同步当前配置</button><p className="diagnostic-hint">管理员更新模型设置或重置密码后，可在这里同步。</p><button className="text-button muted" disabled={Boolean(busy)} onClick={() => void action('restore', async () => { await desktop!.restore(agent); notify('已恢复客户端接管前的配置'); })}><History size={13} />恢复接管前配置</button></>}</div>
    </Modal>}
  </div>;
}
