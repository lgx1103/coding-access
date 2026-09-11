import { useState } from 'react';
import { Select } from './select.js';
import { Activity, ArrowDownLeft, ArrowRight, ArrowUpRight, CircleCheck, Clock3, Layers3, RefreshCw, Users, Zap } from 'lucide-react';
import { dateTime, number } from './api.js';
import { errorCodeLabel } from './ui-format.js';
import { Empty, Loading, Notice, Refresh, Status, useData } from './components.js';

export function Overview({ navigate }: { navigate: (page: string) => void }) {
  const [period, setPeriod] = useState('today');
  const periodLabel = period === 'today' ? '今天' : '最近 7 天';
  const openStatistics = () => { sessionStorage.setItem('aca-statistics-preset', period); navigate('requests'); };
  const { data, error, loading, refresh } = useData(`/api/admin/overview?period=${period}`);
  const providers = useData('/api/admin/providers');
  const models = useData('/api/admin/models');
  const recent = useData('/api/admin/requests');
  if (!data && loading) return <Loading />;
  const stats = data?.stats; const keys = data?.keys ?? [];
  const available = keys.filter((k: any) => k.enabled && !k.states.some((s: any) => s.state)).length;
  const events = data?.events?.filter((e: any) => !e.resolved_at) ?? [];
  const daily = stats?.daily ?? [];
  const max = Math.max(1, ...daily.map((d: any) => Number(d.requests)));
  const providerName = (id: string) => providers.data?.providers.find((p: any) => p.id === id)?.name ?? '接入';
  const cards = [
    { title: '模型调用', value: number(stats?.requests), caption: `${periodLabel}的调用次数`, icon: Activity, accent: 'teal' },
    { title: '已统计用量', value: number(stats?.input_tokens == null ? null : stats.input_tokens + (stats.output_tokens ?? 0)), caption: stats?.unknown_usage ? `${stats.unknown_usage} 次尝试的用量未知` : '按供应商返回统计，单位为词元', icon: Zap, accent: 'amber' },
    { title: '活跃成员', value: number(stats?.active_users), caption: `共 ${data?.employees ?? 0} 位团队成员`, icon: Users, accent: 'blue' },
    { title: '请求成功率', value: stats?.requests ? `${(stats.success / Math.max(1, stats.requests - (stats.running ?? 0)) * 100).toFixed(1)}%` : '—', caption: `自动切换 ${(stats?.retries ?? 0)} 次`, icon: CircleCheck, accent: 'neutral' },
  ];
  return <div className="page-enter"><div className="page-heading"><div><h1>工作台</h1><p>查看{periodLabel}的模型调用与资源状态。</p></div><div className="heading-actions"><div className="overview-period"><Select label="工作台统计时间" value={period} onValueChange={setPeriod} options={[{ value: 'today', label: '今天' }, { value: '7', label: '最近 7 天' }]} /></div><Refresh busy={loading || recent.loading || providers.loading || models.loading} label="刷新概览" onClick={() => { void refresh(); void recent.refresh(); void providers.refresh(); void models.refresh(); }} /></div></div>
    {(error || recent.error || providers.error || models.error) && <Notice error>{error || recent.error || providers.error || models.error}</Notice>}
    <div className="metric-grid">{cards.map(card => <section className="metric-card" key={card.title}><button className="text-button" onClick={openStatistics} aria-label={`查看${card.title}统计`}>查看统计</button><div><span>{card.title}</span><span className={`metric-icon ${card.accent}`}><card.icon size={18} /></span></div><strong>{card.value}</strong><p>{card.caption}</p></section>)}</div>
    <div className="overview-grid"><section className="panel trend-panel"><div className="panel-heading"><div><h2>调用趋势</h2><p>每日请求量</p></div><span className="legend"><i />请求量</span></div>{daily.length ? <div className="chart"><div className="chart-lines"><span>{max}</span><span>{Math.round(max / 2)}</span><span>0</span></div><div className="chart-bars">{daily.map((day: any, i: number) => <div className="chart-column" key={day.day}><div className="chart-bar-track"><div className={`chart-bar ${i === daily.length - 1 ? 'current' : ''}`} style={{ height: `${Math.max(3, day.requests / max * 100)}%` }} title={`${day.day}：${day.requests} 次请求`}><span>{day.requests}</span></div></div><small>{day.day.slice(5).replace('-', '/')}</small></div>)}</div></div> : <Empty title="等待第一次调用" detail="员工完成接入后，调用趋势会显示在这里。" />}<div className="chart-caption"><Clock3 size={14} />平均首响应 {stats?.first_token_ms ? `${(stats.first_token_ms / 1000).toFixed(2)} 秒` : '—'}<span>统计按北京时间展示</span></div></section>
    <section className="panel distribution-panel"><div className="panel-heading"><div><h2>资源分配</h2><p>健康通道共同分担，按负载动态调整</p></div><Layers3 size={19} className="muted" /></div><div className="pool-status"><strong>{available}<span> / {keys.length}</span></strong><span>正常调度的密钥</span></div><div className="key-grid" aria-label="密钥状态">{keys.map((key: any) => <span className={!key.enabled || key.states.some((s: any) => s.state) ? 'key-cell warning' : 'key-cell'} key={key.id} title={`${key.name}：${!key.enabled ? '停用' : key.states.some((s: any) => s.state) ? '异常或冷却' : '正常调度（以实际请求为准）'}`} />)}</div><div className="distribution-list">{(stats?.providers ?? []).map((p: any, i: number) => <div key={p.provider_id}><span><i className={`provider-dot color-${i % 3}`} />{providerName(p.provider_id)}</span><div className="mini-track"><i className={`color-${i % 3}`} style={{ width: `${p.attempts / Math.max(1, stats.attempts) * 100}%` }} /></div><strong>{Math.round(p.attempts / Math.max(1, stats.attempts) * 100)}%</strong></div>)}</div><button className="panel-link" onClick={() => navigate('resources')}>管理密钥池<ArrowRight size={15} /></button></section></div>
    <div className="overview-bottom"><section className="panel recent-panel"><div className="panel-heading"><div><h2>最近调用</h2><p>最近 5 次请求</p></div><button className="text-button" onClick={openStatistics}>全部记录<ArrowUpRight size={14} /></button></div>{recent.data?.requests.length ? <div className="table-scroll"><table><thead><tr><th>成员 / 模型</th><th>时间</th><th>用量（词元）</th><th>状态</th></tr></thead><tbody>{recent.data.requests.slice(0, 5).map((r: any) => <tr key={r.id}><td><span className="person-model"><strong>{r.user_name}</strong><small>{models.data?.models.find((model: any) => model.id === r.model_id)?.name ?? (models.data ? '已移除的模型' : '模型名称加载中')}</small></span></td><td className="muted">{dateTime(r.started_at)}</td><td className="tabular">{number(r.input_tokens == null ? null : r.input_tokens + (r.output_tokens ?? 0))}</td><td><Status value={r.status} /></td></tr>)}</tbody></table></div> : <Empty title="还没有调用记录" />}</section>
    <section className="panel attention-panel"><div className="panel-heading"><div><h2>待处理事项 <span className="count">{events.length}</span></h2><p>需要检查的资源异常</p></div></div>{events.length ? <div className="attention-list">{events.slice(0, 4).map((event: any) => <button key={event.id} onClick={() => navigate('resources')}><span className="attention-icon"><RefreshCw size={17} /></span><span><strong>{event.code === 'invalid_api_key' ? '访问凭证需要更新' : '资源通道需要检查'}</strong><small>{errorCodeLabel(event.code)}</small><em>{dateTime(event.last_at)} · 已合并 {event.count} 次</em></span><ArrowUpRight size={14} /></button>)}</div> : <div className="all-clear"><CircleCheck size={32} /><h3>当前没有待处理异常</h3><p>通道状态会随实际请求持续更新。</p></div>}<div className="attention-footnote"><ArrowDownLeft size={14} />限流冷却与恢复由网关自动处理</div></section></div>
  </div>;
}
