import { dateTime, fullNumber, number } from './api.js';
import { Empty, Loading, Notice, Refresh, Status, useData } from './components.js';
import type { EmployeeModel } from '../shared/types.js';

export function EmployeeUsage({ notify }: { notify: (message: string) => void }) {
  const stats = useData('/api/me/stats');
  const requests = useData('/api/me/requests');
  const models = useData<{ models: EmployeeModel[] }>('/api/models');
  const loading = stats.loading || requests.loading || models.loading;
  const refresh = async () => {
    const results = await Promise.all([stats.refresh(), requests.refresh(), models.refresh()]);
    if (results.every(Boolean)) notify('用量已更新');
  };
  const rows = requests.data?.requests.slice(0, 20) ?? [];
  return <div className="employee-usage page-enter">
    <div className="page-heading"><div><h1>我的用量</h1><p>查看个人调用统计与最近记录。</p></div><Refresh busy={loading} label="刷新我的用量" onClick={() => void refresh()} /></div>
    {(stats.error || requests.error || models.error) && <Notice error>{stats.error || requests.error || models.error}</Notice>}
    {stats.loading && !stats.data ? <Loading /> : <div className="usage-cards">
      <section className="usage-card panel"><h2>调用次数</h2><strong>{number(stats.data?.requests)}</strong><p>最近 7 天</p></section>
      <section className="usage-card panel"><h2>已统计用量（Token）</h2><strong title={stats.data?.input_tokens == null ? undefined : fullNumber(stats.data.input_tokens + (stats.data.output_tokens ?? 0))}>{number(stats.data?.input_tokens == null ? null : stats.data.input_tokens + (stats.data.output_tokens ?? 0))}</strong><p>输入 {fullNumber(stats.data?.input_tokens)} · 输出 {fullNumber(stats.data?.output_tokens)}</p>{stats.data?.unknown_usage > 0 && <p>{stats.data.unknown_usage} 次供应商请求的用量未知</p>}</section>
      <section className="usage-card panel"><h2>请求成功率</h2><strong>{stats.data?.requests ? `${Math.round(stats.data.success / stats.data.requests * 100)}%` : '—'}</strong><p>最近 7 天 · {number(stats.data?.success)} 次成功</p></section>
    </div>}
    <p className="usage-explanation">Token 按供应商返回的输入和输出统计，包含工具说明、项目规则与对话上下文。每次请求分别累计。</p>
    <section className="panel"><div className="panel-heading"><div><h2>最近调用</h2><p>最新 20 条个人请求 · 显示精确 Token 数</p></div></div>{requests.loading && !requests.data ? <Loading /> : rows.length ? <div className="table-scroll"><table><thead><tr><th>模型</th><th>输入 Token</th><th>输出 Token</th><th>状态</th><th>时间</th></tr></thead><tbody>{rows.map((r: any) => <tr key={r.id}><td><strong>{models.data?.models.find(m => m.id === r.model_id)?.name ?? r.model_id}</strong>{r.unknown_usage > 0 && <small className="cell-caption amber-text">含未知用量</small>}</td><td className="tabular">{fullNumber(r.input_tokens)}</td><td className="tabular">{fullNumber(r.output_tokens)}</td><td><Status value={r.status} /></td><td className="muted">{dateTime(r.started_at)}</td></tr>)}</tbody></table></div> : <Empty title="还没有调用记录" detail="在编程工具中使用团队模型后，点击刷新即可查看。" />}</section>
  </div>;
}
