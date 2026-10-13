import type { LeadershipAccount, LeadershipRow } from '../services/apiTypes'
import { hours, money, pct, pts } from './format'
import { useMemo, useState } from 'react'
import { accountSummary, type AccountSummary, type MetricOptions } from './metrics'
import { compareGroups, compareSites, delta, hoursChange, moneyChange, pctChange, type Delta, type SiteCompare } from './monthDelta'
import { daysInMonth, segmentLabel, segmentOrder, useMonthRows } from './data'
import { monthLabel, monthShort } from './routes'
import { useLeadership } from './state'
import { Pills, Skeleton, SortTable, useVocab, type Column } from './ui'
import { wordsFor } from './vocab'

/** Tone of a change: rising is bad for cost-like measures (labor %, OT cost). */
const riseBad = (v: number | null, eps = 0) => (v == null ? '' : v > eps ? 'bad' : v < -eps ? 'ok' : '')

type View = 'totals' | 'groups' | 'sites'

/**
 * The Compare months tab: the month rollup against a comparison month (the header's Compare to, the
 * month before by default), one view at a time: account totals, each group, or each site, with the
 * change in dollars and percent (labor % in points).
 */
export function MonthCompare({ account, month, summary, options }: {
  account: LeadershipAccount; month: string
  summary: AccountSummary<LeadershipRow>
  options: MetricOptions
}) {
  const { navigate, can, compareMonth } = useLeadership()
  const w = wordsFor(useVocab())
  const [view, setView] = useState<View>('totals')
  const compare = compareMonth ?? month
  const query = useMonthRows(account.slug, compareMonth)
  const prior = useMemo(() => (query.data?.rows.length
    ? accountSummary(query.data.rows, { ...options, periodDays: daysInMonth(compare) }, segmentOrder(account)) : null), [query.data, options, compare, account])
  const loading = query.loading
  const sameYear = month.slice(0, 4) === compare.slice(0, 4)
  const tag = (m: string) => (sameYear ? monthShort(`${m}-01`) : monthLabel(`${m}-01`))
  const cur = tag(month), cmp = tag(compare)
  const title = `${monthLabel(`${month}-01`)} vs ${monthLabel(`${compare}-01`)}`
  if (loading) return <div className="card"><div className="ct"><span>{title}</span></div><Skeleton height={160} /></div>
  if (query.error || !prior) return <div className="card"><div className="ct"><span>{title}</span></div><p className="empty">No data for {monthLabel(`${compare}-01`)}.</p></div>

  const a = summary.account, b = prior.account
  const measures: { label: string; d: Delta; fmt: (v: number | null) => string; change: (v: number | null) => string; tone?: string; points?: boolean }[] = [
    { label: w.invoiceCol, d: delta(summary.all.invoice, prior.all.invoice), fmt: money, change: moneyChange },
    { label: w.laborCol, d: delta(a.cost, b.cost), fmt: money, change: moneyChange },
    { label: 'Labor %', d: delta(a.measurePct, b.measurePct), fmt: pct, change: pts, points: true },
    { label: 'Hours', d: delta(a.hours, b.hours), fmt: hours, change: hoursChange },
    { label: 'OT hours', d: delta(a.otHours, b.otHours), fmt: hours, change: hoursChange },
    { label: 'OT cost', d: delta(a.otDollars, b.otDollars), fmt: money, change: moneyChange },
    ...(can('data.allocations') ? [{ label: 'Margin', d: delta(a.margin, b.margin), fmt: money, change: moneyChange }] : []),
    { label: 'Billed sites', d: delta(summary.billed.count, prior.billed.count), fmt: hours, change: hoursChange },
  ]
  for (const m of measures) if (m.label === 'Labor %') m.tone = riseBad(m.d.diff, 0.0005)
    else if (m.label === 'OT cost') m.tone = riseBad(m.d.diff)
    else if (m.label === 'Margin') m.tone = m.d.diff == null ? '' : m.d.diff < 0 ? 'bad' : 'ok'

  const groups = compareGroups(summary, prior)
  const sites = compareSites(summary.sites, prior.sites)
  const siteCols: Column<SiteCompare>[] = [
    { key: 'job', header: 'Job', left: true, value: (r) => Number(r.job) || r.job },
    { key: 'site', header: 'Site', left: true, value: (r) => r.site, className: 'nm' },
    ...(groups.length > 1 ? [{ key: 'seg', header: segmentLabel(account), left: true, value: (r: SiteCompare) => r.segment ?? 'Catch-all' }] : []),
    { key: 'inv', header: `${w.invoiceCol} ${cur}`, value: (r) => r.invoice.cur, render: (r) => money(r.invoice.cur) },
    { key: 'invd', header: `${w.invoiceCol} change`, value: (r) => r.invoice.diff, render: (r) => moneyChange(r.invoice.diff) },
    { key: 'lab', header: `${w.laborCol} ${cur}`, value: (r) => r.cost.cur, render: (r) => <b>{money(r.cost.cur)}</b> },
    { key: 'labp', header: `${w.laborCol} ${cmp}`, value: (r) => r.cost.cmp, render: (r) => <span className="neutral">{money(r.cost.cmp)}</span> },
    { key: 'labd', header: 'Change', value: (r) => r.cost.diff, render: (r) => moneyChange(r.cost.diff) },
    { key: 'labpct', header: 'Change %', value: (r) => r.cost.pct, render: (r) => pctChange(r.cost.pct) },
    { key: 'lp', header: `Labor % ${cur}`, value: (r) => r.measurePct.cur, render: (r) => pct(r.measurePct.cur) },
    { key: 'lpp', header: `Labor % ${cmp}`, value: (r) => r.measurePct.cmp, render: (r) => <span className="neutral">{pct(r.measurePct.cmp)}</span> },
    { key: 'lpd', header: 'Labor % change', value: (r) => r.measurePct.diff, render: (r) => <span className={riseBad(r.measurePct.diff, 0.0005)}>{pts(r.measurePct.diff)}</span> },
    { key: 'otd', header: 'OT cost change', value: (r) => r.otDollars.diff, render: (r) => <span className={riseBad(r.otDollars.diff)}>{moneyChange(r.otDollars.diff)}</span> },
  ]

  const views: { value: View; label: string }[] = [
    { value: 'totals', label: 'Totals' },
    ...(groups.length > 1 ? [{ value: 'groups' as const, label: `By ${segmentLabel(account)}` }] : []),
    { value: 'sites', label: 'By site' },
  ]
  const shown = views.some((v) => v.value === view) ? view : 'totals'
  return <div className="card month-compare">
    <div className="ct"><span>{title}</span><Pills label="Comparison view" options={views} value={shown} onChange={setView} /></div>
    {shown === 'totals' && <div className="tw"><table>
      <caption className="sr-only">{title}, account totals</caption>
      <thead><tr><th className="nosort l" scope="col">Measure</th><th className="nosort" scope="col">{cur}</th><th className="nosort" scope="col">{cmp}</th><th className="nosort" scope="col">Change</th><th className="nosort" scope="col">Change %</th></tr></thead>
      <tbody>{measures.map((m) => <tr key={m.label}><td className="l">{m.label}</td><td><b>{m.fmt(m.d.cur)}</b></td><td className="neutral">{m.fmt(m.d.cmp)}</td>
        <td className={m.tone}>{m.change(m.d.diff)}</td><td className={m.tone}>{m.points ? '–' : pctChange(m.d.pct)}</td></tr>)}</tbody>
    </table></div>}
    {shown === 'groups' && <div className="tw"><table>
      <caption className="sr-only">{title}, by {segmentLabel(account).toLowerCase()}</caption>
      <thead><tr><th className="nosort l" scope="col">{segmentLabel(account)}</th><th className="nosort" scope="col">{w.invoiceCol} change</th><th className="nosort" scope="col">{w.laborCol} {cur}</th><th className="nosort" scope="col">{w.laborCol} {cmp}</th>
        <th className="nosort" scope="col">Change</th><th className="nosort" scope="col">Change %</th><th className="nosort" scope="col">Labor % {cur}</th><th className="nosort" scope="col">Labor % {cmp}</th><th className="nosort" scope="col">Labor % change</th></tr></thead>
      <tbody>{groups.map((g) => <tr key={g.name}><td className="l">{g.name}</td><td>{moneyChange(g.invoice.diff)}</td><td><b>{money(g.cost.cur)}</b></td><td className="neutral">{money(g.cost.cmp)}</td>
        <td>{moneyChange(g.cost.diff)}</td><td>{pctChange(g.cost.pct)}</td><td>{pct(g.measurePct.cur)}</td><td className="neutral">{pct(g.measurePct.cmp)}</td>
        <td className={riseBad(g.measurePct.diff, 0.0005)}>{pts(g.measurePct.diff)}</td></tr>)}</tbody>
    </table></div>}
    {shown === 'sites' && <SortTable caption={`${title}, by site`} rows={sites} columns={siteCols} defaultSort={{ key: 'labd', dir: -1 }} pageSize={50}
      rowClass={(r) => (r.cost.cur == null ? 'dim' : '')}
      onRowClick={(r) => navigate({ site: { company: r.company ?? '', job: r.job } })} rowLabel={(r) => `Open ${r.site}`}
      csvName={`${account.slug}-${month}-vs-${compare}`} />}
  </div>
}
