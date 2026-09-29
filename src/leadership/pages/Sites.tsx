import { useState } from 'react'
import type { LeadershipAccount, LeadershipRow } from '../../services/apiTypes'
import { closedMonths, includesVendor, monthLaborPct, siteMonths, useMonthly, vendorLabel } from '../data'
import { hours1, money, pct } from '../format'
import { accountSummary, statusOf, type AccountSummary, type MetricOptions, type SiteMetrics } from '../metrics'
import { directOf, palletOf, variableWk } from '../Overview'
import { monthShort } from '../routes'
import { useLeadership } from '../state'
import { Badge, Pills, SortTable, toneOf, useVocab, type Column } from '../ui'
import { wordsFor } from '../vocab'

type Row = SiteMetrics<LeadershipRow>

export const roleBadge = (r: Row) => (r.role === 'catch_all' ? <Badge status="none" label="Catch-all" /> : r.role === 'non_billed' ? <Badge status="none" label="Non-billed" /> : <Badge status={r.status} />)

/**
 * Every account's site table. Columns that depend on data appear only where the account has it:
 * fixed / variable invoice (a Job Cost Analysis revenue split), pallet labor (rolled-in pallet jobs),
 * the vendor column (accounts whose labor % counts agency or subcontractor cost). Prior closed months'
 * labor % come from job cost (sub counted at the account's factor), else the row's prior month.
 */
export function Sites({ account, summary, options, selfOnly }: { account: LeadershipAccount; summary: AccountSummary<LeadershipRow>; options: MetricOptions; selfOnly: boolean }) {
  const { navigate } = useLeadership()
  const w = wordsFor(useVocab())
  const [filter, setFilter] = useState('All')
  const monthly = useMonthly(account.slug)
  const factor = options.vendorFactor ?? 1
  const closed = closedMonths(monthly.data).slice(-2)
  const hasCatch = summary.sites.some((r) => r.role === 'catch_all')
  const hasNb = summary.sites.some((r) => r.role === 'non_billed')
  const groups = ['All', ...summary.segments.map((s) => s.segment), ...(hasCatch ? ['Catch-all'] : []), ...(hasNb ? ['Non-billed'] : [])]
  const rows = summary.sites.filter((r) => filter === 'All' || (filter === 'Catch-all' ? r.role === 'catch_all' : filter === 'Non-billed' ? r.role === 'non_billed' : r.segment === filter && r.role === 'site'))
  const hasVariable = summary.sites.some((r) => variableWk(r, options) != null)
  const hasPallet = summary.sites.some((r) => palletOf(r) > 0 || (r.kids?.length ?? 1) > 1)
  const vendor = includesVendor(account) && !selfOnly
  const allocated = summary.sites.some((r) => r.allocation > 0)
  const fixed = (r: Row) => r.invoice - (variableWk(r, options) ?? 0)
  const budget = (r: Row) => (r.invoice > 0 ? r.invoice * r.target : null)
  const variance = (r: Row) => (r.invoice > 0 ? r.cost - r.invoice * r.target : null)
  const lpOf = (r: Row, m: string) => (monthly.data ? monthLaborPct(siteMonths(monthly.data.jobs, r.company, r.kids, r.job_number), m, factor) : null)
  const priorMonth = rows.find((r) => r.revenue_month)?.revenue_month ?? null

  const cols: Column<Row>[] = [
    { key: 'job', header: 'Job', left: true, value: (r) => Number(r.job_number) || r.job_number, render: (r) => <>{r.job_number}{(r.kids?.length ?? 1) > 1 && <span className="neutral"> +{r.kids!.slice(1).join(',')}</span>}</> },
    { key: 'name', header: 'Site', left: true, value: (r) => r.site_name, className: 'nm', render: (r) => <>{r.site_name}{r.labor > 0 && r.labor_basis !== 'pay_report' && <span className="warn"> ~</span>}</> },
    ...(hasVariable ? [
      { key: 'fix', header: 'Fixed inv', value: fixed, render: (r: Row) => money(fixed(r)) },
      { key: 'var', header: 'Var inv', value: (r: Row) => variableWk(r, options), render: (r: Row) => (variableWk(r, options) ? money(variableWk(r, options)) : '–') },
    ] : []),
    { key: 'inv', header: w.invoiceCol, value: (r) => r.invoice, render: (r) => money(r.invoice) },
    { key: 'dir', header: w.directCol, value: directOf, render: (r) => money(directOf(r)) },
    ...(hasPallet ? [{ key: 'pal', header: 'Pallet $', value: palletOf, render: (r: Row) => (palletOf(r) ? money(palletOf(r)) : '–') }] : []),
    ...(vendor ? [{ key: 'ven', header: w.subCol(vendorLabel(account)), value: (r: Row) => r.vendor, render: (r: Row) => (r.vendor ? money(r.vendor) : '–') }] : []),
    { key: 'lab', header: w.laborCol, value: (r) => r.cost, render: (r) => <b>{money(r.cost)}</b> },
    { key: 'lp', header: 'Labor %', value: (r) => r.measurePct, render: (r) => <span className={toneOf(r.status)}>{pct(r.measurePct)}</span> },
    ...(closed.length
      ? closed.map((m): Column<Row> => ({ key: `lp-${m}`, header: w.prior(monthShort(m)), value: (r) => lpOf(r, m), render: (r) => <span className="neutral">{pct(lpOf(r, m))}</span> }))
      : [{ key: 'prior', header: w.prior(monthShort(priorMonth)), value: (r: Row) => r.priorLaborPct, render: (r: Row) => <span className="neutral">{pct(r.priorLaborPct)}</span> }]),
    { key: 'bud', header: 'Budget', value: budget, render: (r) => <span className="neutral">{money(budget(r))}</span> },
    { key: 'var$', header: '$ Var', value: variance, render: (r) => { const v = variance(r); return <span className={v == null ? '' : v > 0 ? 'bad' : 'ok'}>{money(v)}</span> } },
    ...(allocated ? [
      { key: 'alloc', header: 'Alloc $', value: (r: Row) => r.allocation, render: (r: Row) => <span className="neutral">{money(r.allocation)}</span> },
      { key: 'mgn', header: 'Margin', value: (r: Row) => r.margin, render: (r: Row) => <span className={r.margin < 0 ? 'bad' : ''}>{money(r.margin)}</span> },
    ] : []),
    { key: 'hrs', header: 'Hours', value: (r) => r.hours, render: (r) => hours1(r.hours) },
    { key: 'oth', header: 'OT hrs', value: (r) => r.ot_hours, render: (r) => hours1(r.ot_hours) },
    { key: 'otp', header: 'OT %', value: (r) => r.otPct, render: (r) => <span className={r.otPct > 0.25 ? 'bad' : r.otPct > 0.15 ? 'warn' : ''}>{pct(r.otPct)}</span> },
    { key: 'over', header: w.hoursOverCol, value: (r) => r.overHours, render: (r) => (r.overHours > 0.5 ? <span className="bad">{hours1(r.overHours)}</span> : '–') },
    { key: 'st', header: 'Status', value: (r) => r.measurePct, render: roleBadge, csv: (r) => (r.role === 'site' ? r.status : r.role) },
  ]
  const s = accountSummary(rows, options, []).all
  const sum = (f: (r: Row) => number | null) => rows.reduce((a, r) => a + (f(r) ?? 0), 0)
  const totalVar = sum(variance)
  const priorCols = closed.length || 1
  const tot = <tr className="tot"><td></td><td className="l">Total ({rows.length})</td>
    {hasVariable && <><td>{money(sum(fixed))}</td><td>{money(sum((r) => variableWk(r, options)))}</td></>}
    <td>{money(s.invoice)}</td><td>{money(sum(directOf))}</td>{hasPallet && <td>{money(sum(palletOf))}</td>}{vendor && <td>{money(s.vendor)}</td>}<td>{money(s.cost)}</td>
    <td className={toneOf(statusOf(s.measurePct, options.target, options.watchBand))}>{pct(s.measurePct)}</td>{Array.from({ length: priorCols }, (_, i) => <td key={i} />)}
    <td className="neutral">{money(sum(budget))}</td><td className={totalVar > 0 ? 'bad' : 'ok'}>{money(totalVar)}</td>
    {allocated && <><td className="neutral">{money(s.allocation)}</td><td className={s.margin < 0 ? 'bad' : ''}>{money(s.margin)}</td></>}
    <td>{hours1(s.hours)}</td><td>{hours1(s.otHours)}</td><td>{pct(s.otPct)}</td><td>{hours1(sum((r) => r.overHours))}</td><td></td></tr>
  return <>
    <Pills label="Filter sites" options={groups.map((o) => ({ value: o, label: o }))} value={filter} onChange={setFilter} />
    <div className="card"><SortTable caption={`${account.name} sites`} rows={rows} columns={cols} defaultSort={{ key: 'lp', dir: -1 }} total={tot} pageSize={100}
      rowClass={(r) => (r.role !== 'site' || !(r.invoice > 0) ? 'dim' : '')} onRowClick={(r) => navigate({ site: { company: r.company ?? '', job: r.job_number } })}
      rowLabel={(r) => `Open ${r.site_name}`} csvName={`${account.slug}-sites`} /></div>
  </>
}
