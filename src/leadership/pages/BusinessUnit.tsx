import { useMemo } from 'react'
import type { LeadershipAccount, LeadershipRow } from '../../services/apiTypes'
import { SiteCharts } from '../AmazonCharts'
import { rowsOfWeek, segmentLabel, useRows, vendorLabel } from '../data'
import { hours, hours1, money, pct } from '../format'
import { accountSummary, statusOf, type AccountSummary, type MetricOptions, type SiteMetrics } from '../metrics'
import { directOf } from '../Overview'
import { addDays } from '../routes'
import { useLeadership } from '../state'
import { Empty, Kpi, SortTable, toneOf, type Column } from '../ui'

type Row = SiteMetrics<LeadershipRow>
const keyOf = (r: { company?: string | null; job_number: string }) => `${r.company ?? ''}~${r.job_number}`
const budgetOf = (r: Row) => (r.invoice > 0 ? r.invoice * r.target : null)
const varianceOf = (r: Row) => (r.invoice > 0 ? r.cost - r.invoice * r.target : null)
const signed = (v: number | null, format: (x: number) => string) => (v == null ? '–' : `${v >= 0 ? '+' : '−'}${format(Math.abs(v))}`)
const costTone = (v: number | null) => (v == null ? '' : v >= 1 ? 'bad' : v <= -1 ? 'ok' : '')
const otTone = (r: Row) => (r.otPct > 0.25 ? 'bad' : r.otPct > 0.15 ? 'warn' : '')

/** The prior week's site figures, keyed by company and job. */
function usePriorWeek(account: LeadershipAccount, options: MetricOptions) {
  const { weekStart } = useLeadership()
  const q = useRows(account.slug, 2)
  return useMemo(() => {
    const rows = weekStart ? rowsOfWeek(q.data?.rows, addDays(weekStart, -7)) : []
    return new Map(rows.length ? accountSummary(rows, options, []).sites.map((r) => [keyOf(r), r]) : [])
  }, [q.data, weekStart, options])
}

/** One business unit: its figures, the site charts and the site breakdown with week-over-week changes. */
export function BusinessUnit({ account, summary, options, segment }: { account: LeadershipAccount; summary: AccountSummary<LeadershipRow>; options: MetricOptions; segment: string }) {
  const { navigate, weekStart } = useLeadership()
  const prior = usePriorWeek(account, options)
  const rows = summary.sites.filter((r) => r.role === 'site' && r.segment === segment)
  if (!rows.length) return <Empty>No sites in {segment} this week.</Empty>
  const s = accountSummary(rows, options, []).all
  const target = summary.segments.find((g) => g.segment === segment)?.target ?? options.target
  const before = rows.map((r) => prior.get(keyOf(r))).filter((r): r is Row => Boolean(r))
  const change = (f: (r: Row) => number) => (prior.size ? rows.reduce((x, r) => x + f(r), 0) - before.reduce((x, r) => x + f(r), 0) : null)
  const was = (r: Row, f: (x: Row) => number) => { const p = prior.get(keyOf(r)); return prior.size ? f(r) - (p ? f(p) : 0) : null }
  const sum = (f: (r: Row) => number | null) => rows.reduce((x, r) => x + (f(r) ?? 0), 0)
  const vendorCol = vendorLabel(account)
  const cols: Column<Row>[] = [
    { key: 'name', header: 'Site', left: true, value: (r) => r.site_name, className: 'nm' },
    { key: 'dir', header: 'Direct $', value: directOf, render: (r) => money(directOf(r)) },
    { key: 'ven', header: vendorCol, value: (r) => r.vendor, render: (r) => (r.vendor ? money(r.vendor) : '–') },
    { key: 'lab', header: 'Total labor', value: (r) => r.cost, render: (r) => <b>{money(r.cost)}</b> },
    { key: 'lp', header: 'Labor %', value: (r) => r.measurePct, render: (r) => <span className={toneOf(r.status)}>{pct(r.measurePct)}</span> },
    { key: 'bud', header: 'Budget', value: budgetOf, render: (r) => <span className="neutral">{money(budgetOf(r))}</span> },
    { key: 'var', header: '$ Var', value: varianceOf, render: (r) => <span className={costTone(varianceOf(r))}>{signed(varianceOf(r), money)}</span> },
    { key: 'wow', header: 'WoW $', value: (r) => was(r, (x) => x.cost), render: (r) => <span className={costTone(was(r, (x) => x.cost))}>{signed(was(r, (x) => x.cost), money)}</span> },
    { key: 'hrs', header: 'Hours', value: (r) => r.hours, render: (r) => hours1(r.hours) },
    { key: 'woh', header: 'WoW hrs', value: (r) => was(r, (x) => x.hours), render: (r) => signed(was(r, (x) => x.hours), hours1) },
    { key: 'oth', header: 'OT hrs', value: (r) => r.ot_hours, render: (r) => hours1(r.ot_hours) },
    { key: 'otp', header: 'OT %', value: (r) => r.otPct, render: (r) => <span className={otTone(r)}>{pct(r.otPct)}</span> },
    { key: 'wot', header: 'WoW OT', value: (r) => was(r, (x) => x.ot_hours), render: (r) => signed(was(r, (x) => x.ot_hours), hours1) },
  ]
  const totalVar = sum(varianceOf)
  const total = <tr className="tot"><td className="l">Total ({rows.length})</td><td>{money(sum(directOf))}</td><td>{money(s.vendor)}</td><td>{money(s.cost)}</td>
    <td className={toneOf(statusOf(s.measurePct, target, options.watchBand))}>{pct(s.measurePct)}</td><td className="neutral">{money(sum(budgetOf))}</td>
    <td className={costTone(totalVar)}>{signed(totalVar, money)}</td><td className={costTone(change((x) => x.cost))}>{signed(change((x) => x.cost), money)}</td>
    <td>{hours1(s.hours)}</td><td>{signed(change((x) => x.hours), hours1)}</td><td>{hours1(s.otHours)}</td><td>{pct(s.otPct)}</td><td>{signed(change((x) => x.ot_hours), hours1)}</td></tr>
  return <>
    <div className="kpi-lg">
      <Kpi label="Labor cost" value={money(s.cost)} sub={`${signed(change((x) => x.cost), money)} WoW`} />
      <Kpi label="Total hours" value={hours(s.hours)} sub={`${signed(change((x) => x.hours), hours)} WoW`} />
      <Kpi label="Labor %" value={pct(s.measurePct)} tone={toneOf(statusOf(s.measurePct, target, options.watchBand))} sub={`Target ${pct(target)}`} />
      <Kpi label="OT hours" value={hours(s.otHours)} sub={`${pct(s.otPct)} of hours; ${signed(change((x) => x.ot_hours), hours)} WoW`} />
    </div>
    <SiteCharts account={account} rows={rows} options={options} weekStart={weekStart} part="top" />
    <div className="card"><SortTable caption={`${segment} site breakdown`} rows={rows} columns={cols} defaultSort={{ key: 'lp', dir: -1 }} total={total} pageSize={100}
      onRowClick={(r) => navigate({ site: { company: r.company ?? '', job: r.job_number } })} rowLabel={(r) => `Open ${r.site_name}`} csvName={`${account.slug}-${segment.toLowerCase().replace(/\s+/g, '-')}`} /></div>
    <SiteCharts account={account} rows={rows} options={options} weekStart={weekStart} part="bottom" />
  </>
}

/** Every site whose labor ran over its budget (invoicing at its target), largest overage first. */
export function SitesOverBudget({ account, summary, options }: { account: LeadershipAccount; summary: AccountSummary<LeadershipRow>; options: MetricOptions }) {
  const { navigate } = useLeadership()
  const prior = usePriorWeek(account, options)
  const sites = summary.sites.filter((r) => r.role === 'site' && r.invoice > 0)
  const rows = sites.filter((r) => (varianceOf(r) ?? 0) > 0)
  if (!rows.length) return <Empty>No sites over budget.</Empty>
  const over = rows.reduce((x, r) => x + (varianceOf(r) ?? 0), 0)
  const wow = (r: Row) => { const p = prior.get(keyOf(r)); return prior.size ? r.cost - (p?.cost ?? 0) : null }
  const cols: Column<Row>[] = [
    { key: 'seg', header: segmentLabel(account), left: true, value: (r) => r.segment ?? '', render: (r) => <span className="neutral">{r.segment ?? '–'}</span> },
    { key: 'name', header: 'Site', left: true, value: (r) => r.site_name, className: 'nm' },
    { key: 'lab', header: 'Total labor', value: (r) => r.cost, render: (r) => money(r.cost) },
    { key: 'bud', header: 'Budget', value: budgetOf, render: (r) => <span className="neutral">{money(budgetOf(r))}</span> },
    { key: 'var', header: '$ Var', value: varianceOf, render: (r) => <b className="bad">{signed(varianceOf(r), money)}</b> },
    { key: 'lp', header: 'Labor %', value: (r) => r.measurePct, render: (r) => <span className={toneOf(r.status)}>{pct(r.measurePct)}</span> },
    { key: 'tgt', header: 'Target', value: (r) => r.target, render: (r) => <span className="neutral">{pct(r.target)}</span> },
    { key: 'wow', header: 'WoW $', value: wow, render: (r) => <span className={costTone(wow(r))}>{signed(wow(r), money)}</span> },
    { key: 'oth', header: 'OT hrs', value: (r) => r.ot_hours, render: (r) => hours1(r.ot_hours) },
    { key: 'otp', header: 'OT %', value: (r) => r.otPct, render: (r) => <span className={otTone(r)}>{pct(r.otPct)}</span> },
  ]
  return <>
    <div className="kpi-lg">
      <Kpi label="Sites over budget" value={rows.length} sub={`of ${sites.length} billed`} tone="bad" />
      <Kpi label="Over budget" value={money(over)} tone="bad" />
    </div>
    <div className="card"><SortTable caption="Sites over budget" rows={rows} columns={cols} defaultSort={{ key: 'var', dir: -1 }} pageSize={100}
      onRowClick={(r) => navigate({ site: { company: r.company ?? '', job: r.job_number } })} rowLabel={(r) => `Open ${r.site_name}`} csvName={`${account.slug}-sites-over-budget`} /></div>
  </>
}
