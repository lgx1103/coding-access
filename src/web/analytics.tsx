import { useEffect, useState } from 'react';
import { Download, ArrowRight } from 'lucide-react';
import { api, desktop, number, fullNumber } from './api.js';
import { Button, Empty, Field, Notice, Refresh, Status, useData } from './components.js';
import { RequestDetail } from './requests.js';
import { AGENTS } from '../shared/types.js';

const dayMs = 86400_000;
const beijingDate = (now: number) => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
export function datePreset(preset: string, now = Date.now()) {
  const today = beijingDate(now); const end = Date.parse(`${today}T00:00:00+08:00`);
  let from = end; let to = end;
  if (preset === 'yesterday') from = to = end - dayMs;
  if (preset === '7' || preset === '30') from = end - (Number(preset) - 1) * dayMs;
  if (preset === 'week') from = end - ((new Date(end + 8 * 3600_000).getUTCDay() + 6) % 7) * dayMs;
  if (preset === 'month') from = Date.parse(`${today.slice(0, 7)}-01T00:00:00+08:00`);
  return { from: beijingDate(from), to: beijingDate(to) };
}
const pct = (n: number, total: number) => total > 0 ? `${(n / total * 100).toFixed(1)}%` : '—';
const csvCell = (value: unknown) => `"${String(value ?? '').replace(/^[\s]*[=+@-]/, "'$&").replaceAll('"', '""')}"`;

export function Analytics({ personal = false }: { personal?: boolean }) {
  const [range, setRange] = useState(() => { const preset = personal ? '7' : sessionStorage.getItem('aca-statistics-preset') ?? '7'; if (!personal) sessionStorage.removeItem('aca-statistics-preset'); return datePreset(preset); }); const [grain, setGrain] = useState('day');
  const [filters, setFilters] = useState({ userIds: '', modelIds: '', agent: '', providerId: '', status: '' });
  const [tab, setTab] = useState('overview'); const [sort, setSort] = useState('total_tokens'); const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<any>(null); const [exportError, setExportError] = useState('');
  const [names, setNames] = useState<{ members: Record<string, string>; models: Record<string, string> }>({ members: {}, models: {} });
  const from = Date.parse(`${range.from}T00:00:00+08:00`); const to = Date.parse(`${range.to}T00:00:00+08:00`) + dayMs;
  const valid = Number.isFinite(from) && Number.isFinite(to) && to > from;
  const params = new URLSearchParams({ from: String(valid ? from : 0), to: String(valid ? to : 1), grain, offset: String(offset), limit: '50' });
  Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value); });
  const result = useData(`/api/${personal ? 'me' : 'admin'}/analytics?${params}`);
  const providers = useData(personal ? '/api/meta' : '/api/admin/providers');
  useEffect(() => { if (result.data) setNames(prev => {
    const next = { members: { ...prev.members }, models: { ...prev.models } };
    for (const row of result.data.choices) { next.members[row.user_id] = row.member_name; next.models[row.model_id] = row.model_label; }
    return next;
  }); }, [result.data]);
  const change = (key: keyof typeof filters, value: string) => { setFilters(f => ({ ...f, [key]: value })); setOffset(0); };
  const data = valid ? result.data : null; const totals = data?.totals;
  const completed = (totals?.requests ?? 0) - (totals?.running ?? 0);
  const ranking = [...(tab === 'members' ? data?.members ?? [] : data?.models ?? [])].sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1) || a.name.localeCompare(b.name));
  async function exportCsv() {
    setExportError('');
    try {
      if (tab === 'details') { const a = document.createElement('a'); a.href = `/api/admin/analytics-export?${params}`; a.download = 'coding-access-usage.csv'; a.click(); return; }
      const rows = tab === 'overview' ? data?.trend ?? [] : ranking;
      const lines = [['日期范围（北京时间）', range.from, range.to], ['名称或日期', '总 Token', '输入', '输出', '缓存读取（包含在输入中）', '调用次数', '重试次数', '未知用量尝试'],
        ...rows.map((r: any) => [r.name ?? r.day, r.total_tokens, r.input_tokens, r.output_tokens, r.cached_tokens, r.requests, r.retries, r.unknown_usage])];
      const contents = '\uFEFF' + lines.map(row => row.map(csvCell).join(',')).join('\r\n');
      if (desktop?.saveText) { await desktop.saveText(`usage-${range.from}-${range.to}-${tab}.csv`, contents); return; }
      const url = URL.createObjectURL(new Blob([contents], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a'); a.href = url; a.download = `usage-${range.from}-${range.to}-${tab}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setExportError('导出失败，请重试。'); }
  }
  return <div className="page-enter analytics-page">
    <div className="page-heading"><div><h1>{personal ? '我的用量' : '用量统计'}</h1><p>按日期、模型{!personal && '和成员'}分析用量，所有时间按北京时间展示。</p></div><div className="heading-actions">
      {(tab !== 'details' || !personal) && <Button kind="secondary" disabled={!data || result.loading} onClick={exportCsv}><Download size={16} />导出当前统计</Button>}<Refresh busy={result.loading} onClick={() => void result.refresh()} />
    </div></div>
    <section className="panel analytics-filters">
      <div className="heading-actions">{[['today', '今天'], ['yesterday', '昨天'], ['week', '本周'], ['month', '本月'], ['7', '近 7 天'], ['30', '近 30 天']].map(([id, label]) => <Button key={id} kind="quiet" onClick={() => { setRange(datePreset(id)); setOffset(0); }}>{label}</Button>)}</div>
      <div className="form-grid">
        <Field label="开始日期"><input type="date" value={range.from} onChange={e => { setRange(r => ({ ...r, from: e.target.value })); setOffset(0); }} /></Field>
        <Field label="结束日期（含当天）"><input type="date" value={range.to} onChange={e => { setRange(r => ({ ...r, to: e.target.value })); setOffset(0); }} /></Field>
        <Field label="趋势粒度"><select value={grain} onChange={e => setGrain(e.target.value)}><option value="day">按天</option><option value="week">按周（周一开始）</option><option value="month">按月</option></select></Field>
        <Field label="模型"><select value={filters.modelIds} onChange={e => change('modelIds', e.target.value)}><option value="">全部模型</option>{Object.entries(names.models).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field>
        {!personal && <Field label="成员（可多选）"><select multiple value={filters.userIds ? filters.userIds.split(',') : []} onChange={e => change('userIds', [...e.target.selectedOptions].map(o => o.value).join(','))}>{Object.entries(names.members).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field>}
        <Field label="编程工具"><select value={filters.agent} onChange={e => change('agent', e.target.value)}><option value="">全部工具</option>{AGENTS.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}<option value="codex">Codex（历史记录）</option></select></Field>
        {!personal && <Field label="曾使用的供应商"><select value={filters.providerId} onChange={e => change('providerId', e.target.value)}><option value="">全部供应商</option>{providers.data?.providers?.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
        <Field label="请求状态"><select value={filters.status} onChange={e => change('status', e.target.value)}><option value="">全部状态</option><option value="success">成功</option><option value="error">失败</option><option value="running">进行中</option><option value="interrupted">中断</option><option value="incomplete">未完整结束</option><option value="cancelled">已取消</option></select></Field>
      </div><Button kind="quiet" onClick={() => { setFilters({ userIds: '', modelIds: '', agent: '', providerId: '', status: '' }); setOffset(0); }}>清空筛选</Button>
      {filters.providerId && <p className="small-note">筛选曾使用该供应商的请求，用量包含这些请求的全部重试。</p>}
    </section>
    {(!valid || result.error || exportError) && <Notice error>{!valid ? '请选择有效的日期范围。' : result.error ? `${result.error}。如连接旧版服务端，请先升级服务端以使用统计中心。` : exportError}</Notice>}
    <div className="analytics-tabs" role="tablist" aria-label="统计视图">{[['overview', '概览'], ['models', '模型排行'], ...(!personal ? [['members', '成员排行']] : []), ['details', '调用明细']].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}</div>
    {data && <><div className="metric-grid">
      {[['已统计 Token', number(totals.total_tokens), `输入 ${number(totals.input_tokens)} · 输出 ${number(totals.output_tokens)}`], ['调用次数', number(totals.requests), `重试 ${totals.retries ?? 0} 次 · 进行中 ${totals.running ?? 0}`], ['最终成功率', pct(totals.success, completed), `首次成功率 ${pct(totals.first_success, completed)} · 排除进行中`], ['活跃成员', number(totals.active_users), `平均首响应 ${totals.first_token_ms == null ? '—' : (totals.first_token_ms / 1000).toFixed(2) + ' 秒'}`]].map(([label, value, caption]) => <section className="metric-card" key={label}><div>{label}</div><strong>{value}</strong><p>{caption}</p></section>)}
    </div><p className="small-note">缓存读取 {fullNumber(totals.cached_tokens)} Token，已包含在输入量中。失败未返回用量 {totals.missing_failed ?? 0} 次；成功但缺少用量 {totals.missing_success ?? 0} 次；等待用量 {totals.pending_usage ?? 0} 次。未知用量不按 0 计算，历史缺失无法补算。</p>
    {tab === 'overview' ? <section className="panel"><div className="panel-heading"><h2>Token 用量趋势</h2></div>{data.trend.length ? <div className="analytics-trend">{data.trend.map((r: any) => <div className="analytics-trend-row" key={r.day}><span>{r.day}</span><div><i style={{ width: `${r.total_tokens == null ? 0 : Math.max(1, r.total_tokens / Math.max(1, ...data.trend.map((d: any) => d.total_tokens ?? 0)) * 100)}%` }} /></div><strong title={fullNumber(r.total_tokens)}>{number(r.total_tokens)}</strong><small>{r.requests} 次</small></div>)}</div> : <Empty title="所选日期暂无用量" />}</section>
      : tab === 'details' ? <section className="panel"><div className="table-scroll"><table><thead><tr><th>成员 / 模型</th><th>输入 / 输出 Token</th><th>状态</th><th>供应商尝试</th><th>时间（北京）</th>{!personal && <th />}</tr></thead><tbody>{data.details.map((r: any) => <tr key={r.id}><td>{r.member_name}<small className="cell-caption">{r.model_label}</small></td><td>{fullNumber(r.input_tokens)} / {fullNumber(r.output_tokens)}{r.unknown_usage > 0 && <small className="cell-caption">含未知用量</small>}</td><td><Status value={r.status} /></td><td>{r.attempts}</td><td>{new Date(r.started_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</td>{!personal && <td><Button kind="quiet" onClick={() => setSelected({ ...r, user_name: r.member_name })}><ArrowRight size={16} />详情</Button></td>}</tr>)}</tbody></table></div>{!data.details.length && <Empty title="暂无匹配的请求" />}<div className="table-footer"><Button kind="quiet" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</Button>第 {Math.floor(offset / 50) + 1} 页 · 共 {totals.requests} 条<Button kind="quiet" disabled={offset + 50 >= totals.requests} onClick={() => setOffset(offset + 50)}>下一页</Button></div></section>
      : <section className="panel"><div className="panel-heading"><h2>{tab === 'members' ? '成员排行' : '模型排行'}</h2><select aria-label="排行排序" value={sort} onChange={e => setSort(e.target.value)}><option value="total_tokens">按总 Token</option><option value="requests">按调用次数</option><option value="input_tokens">按输入 Token</option><option value="output_tokens">按输出 Token</option></select></div><div className="table-scroll"><table><thead><tr><th>排名</th><th>名称</th><th>总 Token</th><th>用量占比</th><th>调用次数</th><th>输入 / 输出</th><th /></tr></thead><tbody>{ranking.map((r: any, i) => <tr key={r.id}><td>{i + 1}</td><td><strong>{r.name}</strong></td><td title={fullNumber(r.total_tokens)}>{number(r.total_tokens)}</td><td>{pct(r.total_tokens ?? 0, totals.total_tokens)}</td><td>{r.requests}</td><td>{number(r.input_tokens)} / {number(r.output_tokens)}</td><td><Button kind="quiet" onClick={() => { change(tab === 'members' ? 'userIds' : 'modelIds', r.id); setTab(tab === 'members' ? 'models' : personal ? 'details' : 'members'); }}>查看{tab === 'members' ? '模型' : personal ? '明细' : '成员贡献'}<ArrowRight size={14} /></Button></td></tr>)}</tbody></table></div>{!ranking.length && <Empty title="暂无排行数据" />}</section>}
    </>}
    {selected && <RequestDetail item={selected} modelName={selected.model_label} onClose={() => setSelected(null)} />}
  </div>;
}
