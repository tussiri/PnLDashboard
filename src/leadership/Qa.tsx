import { useApiQuery } from '../hooks/useApiQuery'
import type { LeadershipAccount, LeadershipQaResponse, LeadershipRow } from '../services/apiTypes'
import { queryKey } from '../services/queryClient'
import { QaVarianceChart, useTokens } from './charts'
import { money, pct } from './format'
import type { SiteMetrics } from './metrics'
import { weekLabel, weekTick } from './routes'
import { useLeadership } from './state'
import { ChartCard, Swatch } from './ui'

export const QA_PASS = 90
export const QA_WARN = 85
export const qaTone = (score: number | null | undefined) => (score == null ? '' : score >= QA_PASS ? 'ok' : score >= QA_WARN ? 'warn' : 'bad')
const signed = (v: number | null) => (v == null ? '–' : `${v >= 0 ? '+' : '−'}${pct(Math.abs(v))}`)

type Row = SiteMetrics<LeadershipRow>

/** Labor against budget dollars at one site; null without a budget. */
export const budgetVariance = (r: Pick<Row, 'labor' | 'budget_dollars'>) => (r.budget_dollars > 0 ? r.labor / r.budget_dollars - 1 : null)

/**
 * The account's weekly QA audit scores (Admin > Imports, kind qa_score): the selected week's score against
 * each site's labor vs budget, and the last 16 weeks by site. Renders nothing when no scores are loaded.
 */
export function QaCards({ account, sites, weekStart }: { account: LeadershipAccount; sites: Row[]; weekStart: string | null }) {
  const { api, keyPrefix, decision } = useLeadership()
  const t = useTokens()
  const week = weekStart ?? undefined
  const q = useApiQuery<LeadershipQaResponse>(decision ? queryKey(`${keyPrefix}/leadership/qa`, { account: account.slug, week, weeks: 16 }) : null,
    (signal) => api.leadershipQa(account.slug, week, signal), [api, account.slug, week])
  const d = q.data
  if (q.error || !d || !d.sites.length) return null
  const latest = d.weeks.at(-1)!
  const byJob = new Map(sites.map((r) => [`${r.company}|${r.job_number}`, r]))
  const points = d.sites.map((s) => {
    const row = s.company && s.job_number ? byJob.get(`${s.company}|${s.job_number}`) : undefined
    return { code: s.site_code, name: s.site_name ?? s.site_code, group: row?.segment ?? '', score: s.scores[latest] ?? null, row, variance: row ? budgetVariance(row) : null }
  }).filter((p) => p.score != null || p.row).sort((a, b) => (a.score ?? 999) - (b.score ?? 999))
  const scored = points.filter((p) => p.score != null)
  const avg = scored.length ? scored.reduce((x, p) => x + p.score!, 0) / scored.length : null
  const exact = weekStart === latest
  const title = `QA score vs budget variance, ${exact ? 'this week' : weekLabel(latest).replace('Week ending', 'QA week ending')}`
  return <>
    {weekStart && points.some((p) => p.variance != null) && <ChartCard title={title} height={300}
      legend={<><Swatch color={t.ok} label={`QA ${QA_PASS}+`} /><Swatch color={t.warn} label={`QA ${QA_WARN} to ${QA_PASS}`} /><Swatch color={t.bad} label={`QA under ${QA_WARN}`} />
        <Swatch line label="Pass and warn" /><span>Average {avg == null ? '–' : avg.toFixed(1)}</span></>}
      chart={<QaVarianceChart labels={points.map((p) => p.code)} variance={points.map((p) => p.variance)} scores={points.map((p) => p.score)} groups={points.map((p) => p.group)} pass={QA_PASS} warn={QA_WARN} />}
      table={<table><thead><tr><th className="nosort l">Site</th><th className="nosort">QA score</th><th className="nosort">Labor</th><th className="nosort">Budget</th><th className="nosort">Vs budget</th></tr></thead>
        <tbody>{points.map((p) => <tr key={p.code}><td className="l" title={p.name}>{p.code}</td>
          <td className={qaTone(p.score)}>{p.score == null ? '–' : p.score.toFixed(1)}</td><td>{p.row ? money(p.row.labor) : '–'}</td>
          <td>{p.row?.budget_dollars ? money(p.row.budget_dollars) : '–'}</td><td className={p.variance == null ? '' : p.variance > 0 ? 'bad' : 'ok'}>{signed(p.variance)}</td></tr>)}</tbody></table>} />}
    <div className="card">
      <div className="ct"><span>QA scores by site, last {d.weeks.length} weeks</span></div>
      <div className="tw"><table className="qa-grid">
        <thead><tr><th className="nosort l">Site</th>{d.weeks.map((wk) => <th key={wk} className="nosort">{weekTick(wk)}</th>)}<th className="nosort">Average</th></tr></thead>
        <tbody>{d.sites.map((s) => {
          const vals = d.weeks.map((wk) => s.scores[wk]).filter((v): v is number => v != null)
          const mean = vals.length ? vals.reduce((x, v) => x + v, 0) / vals.length : null
          return <tr key={s.site_code}><td className="l" title={s.site_name ?? undefined}>{s.site_code}</td>
            {d.weeks.map((wk) => <td key={wk} className={`qa ${qaTone(s.scores[wk])}`}>{s.scores[wk] == null ? '–' : s.scores[wk].toFixed(0)}</td>)}
            <td className={qaTone(mean)}><b>{mean == null ? '–' : mean.toFixed(1)}</b></td></tr>
        })}</tbody>
      </table></div>
    </div>
  </>
}
