import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { z } from 'zod';
import type { Store } from './db.js';
const ids = z.string().max(4000).optional().transform(s => s ? [...new Set(s.split(',').filter(Boolean))].slice(0, 100) : []);
export const analyticsQuery = z.object({
  from: z.coerce.number().int().nonnegative(), to: z.coerce.number().int().nonnegative(), grain: z.enum(['day', 'week', 'month']).default('day'),
  userIds: ids, modelIds: ids, agent: z.string().max(100).optional(), providerId: z.string().max(100).optional(),
  status: z.enum(['success', 'error', 'running', 'interrupted', 'incomplete', 'cancelled']).optional(),
  offset: z.coerce.number().int().nonnegative().max(10_000_000).default(0), limit: z.coerce.number().int().min(1).max(500).default(50),
}).refine(q => q.to > q.from && q.to <= 8_640_000_000_000_000, 'Invalid date range');
export type AnalyticsQuery = z.infer<typeof analyticsQuery>;
// Aggregate attempts first so retries never duplicate logical request counts.
// Provider filtering selects requests that touched it, retaining all their attempts.
function query(q: AnalyticsQuery, selfId?: string) {
  const where = ['r.started_at>=?', 'r.started_at<?']; const args: (string | number)[] = [q.from, q.to];
  const inList = (column: string, values: string[]) => { if (values.length) { where.push(`${column} IN (${values.map(() => '?').join(',')})`); args.push(...values); } };
  inList('r.user_id', selfId ? [selfId] : q.userIds); inList('r.model_id', q.modelIds);
  if (q.agent) { where.push('r.agent=?'); args.push(q.agent); }
  if (q.status) { where.push('r.status=?'); args.push(q.status); }
  if (q.providerId) { where.push('EXISTS (SELECT 1 FROM attempts p WHERE p.request_id=r.id AND p.provider_id=?)'); args.push(q.providerId); }
  const cte = `WITH selected AS (SELECT r.* FROM requests r WHERE ${where.join(' AND ')}),
    usage AS (SELECT a.request_id,COUNT(*) attempts,SUM(a.input_tokens) input_tokens,SUM(a.output_tokens) output_tokens,
      SUM(a.cached_tokens) cached_tokens,SUM(a.input_tokens IS NOT NULL OR a.output_tokens IS NOT NULL) known,
      SUM(COALESCE(a.input_tokens,0)+COALESCE(a.output_tokens,0)) total_tokens,
      SUM(a.input_tokens IS NULL OR a.output_tokens IS NULL) unknown_usage,
      SUM(a.status='success' AND (a.input_tokens IS NULL OR a.output_tokens IS NULL)) missing_success,
      SUM(a.status!='success' AND a.status!='running' AND (a.input_tokens IS NULL OR a.output_tokens IS NULL)) missing_failed,
      SUM(a.status='running') pending_usage
      FROM attempts a JOIN selected r ON r.id=a.request_id GROUP BY a.request_id),
    rows AS (SELECT r.*,COALESCE(json_extract(u.data,'$.name'),r.user_name,r.user_id) member_name,
      COALESCE(json_extract(m.data,'$.name'),r.model_name,r.model_id) model_label,
      COALESCE(a.attempts,0) attempts,a.input_tokens,a.output_tokens,a.cached_tokens,a.known,a.total_tokens,
      COALESCE(a.unknown_usage,0) unknown_usage,COALESCE(a.missing_success,0) missing_success,
      COALESCE(a.missing_failed,0) missing_failed,COALESCE(a.pending_usage,0) pending_usage
      FROM selected r LEFT JOIN usage a ON a.request_id=r.id LEFT JOIN users u ON u.id=r.user_id LEFT JOIN models m ON m.id=r.model_id)`;
  return { cte, args };
}
export function analytics(store: Store, q: AnalyticsQuery, selfId?: string) {
  const { cte, args } = query(q, selfId);
  const metrics = `COUNT(*) requests,SUM(status='success') success,SUM(status='running') running,
    COUNT(DISTINCT user_id) active_users,AVG(first_token_ms) first_token_ms,
    SUM(attempts) attempts,SUM(MAX(attempts-1,0)) retries,SUM(status='success' AND attempts=1) first_success,
    SUM(input_tokens) input_tokens,SUM(output_tokens) output_tokens,SUM(cached_tokens) cached_tokens,
    CASE WHEN SUM(known)>0 THEN SUM(total_tokens) ELSE NULL END total_tokens,
    SUM(unknown_usage) unknown_usage,SUM(missing_success) missing_success,SUM(missing_failed) missing_failed,SUM(pending_usage) pending_usage`;
  const totals = store.db.prepare(`${cte} SELECT ${metrics} FROM rows`).get(...args)!;
  const day = "date(started_at/1000,'unixepoch','+8 hours')";
  const bucket = q.grain === 'month' ? `strftime('%Y-%m-01',${day})` : q.grain === 'week' ? `date(${day},'-'||((CAST(strftime('%w',${day}) AS INTEGER)+6)%7)||' days')` : day;
  const trend = store.db.prepare(`${cte} SELECT ${bucket} day,${metrics} FROM rows GROUP BY day ORDER BY day`).all(...args);
  const rank = (column: 'model_id' | 'user_id', label: 'model_label' | 'member_name') => store.db.prepare(`${cte} SELECT ${column} id,MAX(${label}) name,${metrics} FROM rows GROUP BY ${column} ORDER BY total_tokens DESC,requests DESC,${column}`).all(...args);
  const details = store.db.prepare(`${cte} SELECT * FROM rows ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?`).all(...args, q.limit, q.offset);
  const choices = store.db.prepare(`${cte} SELECT DISTINCT user_id,member_name,model_id,model_label FROM rows`).all(...args);
  return { totals, trend, models: rank('model_id', 'model_label'), members: selfId ? [] : rank('user_id', 'member_name'),
    details: details.map(({ credential_id: _, ...r }) => r), choices, from: q.from, to: q.to, grain: q.grain, offset: q.offset, limit: q.limit, timezone: 'Asia/Shanghai', providerScope: 'requests' };
}

export async function* analyticsExport(store: Store, q: AnalyticsQuery, selfId?: string) {
  const { cte, args } = query(q, selfId);
  const cell = (v: unknown) => '"' + String(v ?? '').replace(/^[\s]*[=+@-]/, "'$&").replaceAll('"', '""') + '"';
  yield '\uFEFF' + ['Request','Member','Model','Agent','Started (UTC)','Status','Attempts','Input tokens','Output tokens','Cached tokens','Unknown attempts'].map(cell).join(',') + '\r\n';
  let batch = 0;
  for (const r of store.db.prepare(`${cte} SELECT * FROM rows ORDER BY started_at DESC,id DESC`).iterate(...args)) {
    if (++batch % 250 === 0) await yieldToRequests();
    yield [r.id,r.member_name,r.model_label,r.agent,new Date(Number(r.started_at)).toISOString(),r.status,r.attempts,r.input_tokens,r.output_tokens,r.cached_tokens,r.unknown_usage].map(cell).join(',') + '\r\n';
  }
}
