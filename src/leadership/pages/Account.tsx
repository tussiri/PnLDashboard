import { lazy, Suspense, useMemo, useState } from 'react'
import type { LeadershipAccount, LeadershipRow } from '../../services/apiTypes'
import { ChartCard, Swatch } from '../ui'
import { OtHoursChart, OverHoursChart, useTokens } from '../charts'
import { dataFlags, measureLabel, rowsOfWeek, segmentOrder, useRows } from '../data'
import { hours, hours1, money, pct, rate } from '../format'
import { accountSummary, type AccountSummary as Summary, type MetricOptions, type SiteMetrics as Metrics } from '../metrics'
import { Overview } from '../Overview'
import { ACCOUNT_TABS, monthShort, weekLabel, type AccountTab } from '../routes'
import { freshnessLine, PageHeader } from '../Shell'
import { useLeadership } from '../state'
import { Badge, Empty, Kpi, LoadError, Pills, Skeleton, SortTable, toneOf, type Column } from '../ui'
import { SiteDrawer } from './SiteDrawer'
import { Vendors } from './Vendors'

type AccountSummary = Summary<LeadershipRow>
type SiteMetrics = Metrics<LeadershipRow>

const SiteMap = lazy(() => import('./SiteMap'))

const TAB_LABEL: Record<AccountTab, string> = { overview: 'Overview', sites: 'Sites', 'over-target': 'Over Target', overtime: 'Overtime', map: 'Map', vendors: 'Vendors' }
const shortName = (name: string) => name.replace(/^[A-Z][A-Za-z]+ ?- ?/, '').replace(/ (Elementary|Middle|High) School$/, ' $1').replace(' Senior High School', ' Sr High')

export const roleBadge = (r: Metrics) => (r.role === 'catch_all' ? <Badge status="none" label="Catch-all" /> : r.role === 'non_billed' ? <Badge status="none" label="Unbilled" /> : <Badge status={r.status} />)

function useSiteOpener() {
  const { navigate } = useLeadership()
  return (r: LeadershipRow) => navigate({ site: { company: r.company ?? '', job: r.job_number } })
}

function SitesTab({ account, summary, priorShort }: { account: LeadershipAccount; summary: AccountSummary; priorShort: string }) {
  const [filter, setFilter] = useState('All')
  const open = useSiteOpener()
  const hasCatch = summary.sites.some((r) => r.role === 'catch_all')
  const hasNb = summary.sites.some((r) => r.role === 'non_billed')
  const vendor = account.cost_basis === 'labor_plus_vendor'
  const options = ['All', ...summary.segments.map((s) => s.segment), ...(hasCatch ? ['Catch-all'] : []), ...(hasNb ? ['Non-billed'] : [])]
  const rows = summary.sites.filter((r) => filter === 'All' || (filter === 'Catch-all' ? r.role === 'catch_all' : filter === 'Non-billed' ? r.role === 'non_billed' : r.segment === filter && r.role === 'site'))
  const m = measureLabel(account)
  const cols: Column<SiteMetrics>[] = [
    { key: 'job', header: 'Job', left: true, value: (r) => r.job_number },
    { key: 'name', header: 'Location', left: true, value: (r) => r.site_name, className: 'nm' },
    { key: 'inv', header: 'Invoice', value: (r) => r.invoice, render: (r) => money(r.invoice) },
    { key: 'lab', header: 'Labor $', value: (r) => r.labor, render: (r) => money(r.labor) },
    ...(vendor ? [{ key: 'ven', header: 'Vendor $', value: (r: SiteMetrics) => r.vendor, render: (r: SiteMetrics) => money(r.vendor) }] : []),
    { key: 'lp', header: m, value: (r) => r.measurePct, render: (r) => <span className={toneOf(r.status)}>{pct(r.measurePct)}</span> },
    { key: 'prior', header: `${priorShort} LP`, value: (r) => r.priorLaborPct, render: (r) => <span className="neutral">{pct(r.priorLaborPct)}</span> },
    { key: 'hrs', header: 'Hours', value: (r) => r.hours, render: (r) => hours1(r.hours) },
    { key: 'bh', header: 'WT budget hrs', value: (r) => r.budget_hours, render: (r) => <span className="neutral">{hours1(r.budget_hours)}</span> },
    { key: 'oth', header: 'OT hrs', value: (r) => r.ot_hours, render: (r) => hours1(r.ot_hours) },
    { key: 'otp', header: 'OT %', value: (r) => r.otPct, render: (r) => <span className={r.otPct > 0.25 ? 'bad' : r.otPct > 0.15 ? 'warn' : ''}>{pct(r.otPct)}</span> },
    { key: 'over', header: 'Hrs over target', value: (r) => r.overHours, render: (r) => (r.overHours > 0.5 ? <span className="bad">{hours1(r.overHours)}</span> : '–') },
    { key: 'st', header: 'Status', value: (r) => r.measurePct, render: roleBadge, csv: (r) => (r.role === 'site' ? r.status : r.role) },
  ]
  const s = accountSummary(rows, { target: 0 }, [])
  const tot = <tr className="tot"><td></td><td className="l">Total ({rows.length})</td><td>{money(s.all.invoice)}</td><td>{money(s.all.labor)}</td>{vendor && <td>{money(rows.reduce((a, r) => a + r.vendor, 0))}</td>}
    <td>{pct(rows.reduce((a, r) => a + r.cost, 0) / (s.all.invoice || NaN))}</td><td className="neutral">{pct(s.all.priorLaborPct)}</td><td>{hours1(s.all.hours)}</td><td className="neutral">{hours1(s.all.budgetHours)}</td>
    <td>{hours1(s.all.otHours)}</td><td>{pct(s.all.otPct)}</td><td>{hours1(rows.reduce((a, r) => a + r.overHours, 0))}</td><td></td></tr>
  return <>
    <Pills label="Filter sites" options={options.map((o) => ({ value: o, label: o }))} value={filter} onChange={setFilter} />
    <div className="card"><SortTable caption={`${account.name} sites`} rows={rows} columns={cols} defaultSort={{ key: 'lp', dir: -1 }} total={tot}
      rowClass={(r) => (r.role !== 'site' ? 'dim' : '')} onRowClick={open} rowLabel={(r) => `Open ${r.site_name}`} csvName={`${account.slug}-sites`} /></div>
  </>
}

function OverTargetTab({ account, summary, options, priorShort }: { account: LeadershipAccount; summary: AccountSummary; options: MetricOptions; priorShort: string }) {
  const t = useTokens()
  const open = useSiteOpener()
  const o = summary.overTarget
  const top = [...o.rows].sort((a, b) => b.overHours - a.overHours).slice(0, 15)
  const catchJobs = summary.sites.filter((r) => r.role === 'catch_all')
  const cols: Column<SiteMetrics>[] = [
    { key: 'job', header: 'Job', left: true, value: (r) => r.job_number },
    { key: 'name', header: 'Location', left: true, value: (r) => r.site_name, className: 'nm' },
    { key: 'seg', header: 'Segment', left: true, value: (r) => r.segment, render: (r) => <span className="neutral">{r.segment}</span> },
    { key: 'lp', header: measureLabel(account), value: (r) => r.measurePct, render: (r) => <span className={toneOf(r.status)}>{pct(r.measurePct)}</span> },
    { key: 'prior', header: `${priorShort} LP`, value: (r) => r.priorLaborPct, render: (r) => <span className="neutral">{pct(r.priorLaborPct)}</span> },
    { key: 'od', header: '$ over', value: (r) => r.overDollars, render: (r) => money(r.overDollars) },
    { key: 'oh', header: 'Hrs over', value: (r) => r.overHours, render: (r) => <><b>{hours1(r.overHours)}</b><span className="bar" style={{ width: Math.min(80, r.overHours / 3) }} aria-hidden="true" /></> },
    { key: 'op', header: 'OT premium hrs', value: (r) => r.overFromOtPremium, render: (r) => hours1(r.overFromOtPremium) },
    { key: 'ex', header: 'Extra hrs', value: (r) => r.overFromExtraHours, render: (r) => hours1(r.overFromExtraHours) },
    { key: 'br', header: 'Base rate', value: (r) => r.baseRate, render: (r) => rate(r.baseRate) },
  ]
  return <>
    <div className="kpi-lg">
      <Kpi label="Locations over target" value={o.rows.length} sub={`of ${o.billedCount} billed`} tone={o.rows.length ? 'bad' : 'ok'} />
      <Kpi label="Hours over target" value={hours(o.rollup.overHours)} sub="Base-rate equivalent hours" tone="bad" />
      <Kpi label="Dollars over target" value={money(o.rollup.overDollars)} sub={`${account.cost_basis === 'labor_plus_vendor' ? 'Cost' : 'Labor'} above ${pct(options.target)} of invoice`} tone="bad" />
      <Kpi label="From OT premium" value={hours(o.fromOtPremium)} sub={`${pct(o.rollup.overHours ? o.fromOtPremium / o.rollup.overHours : 0)} of the overage`} tone="warn" />
      <Kpi label="From extra hours" value={hours(o.fromExtraHours)} sub="Hours beyond what billing supports" />
    </div>
    {catchJobs.length > 0 && <div className="note info"><b>Plus {hours(summary.catchAllOverHours)} base-rate hours from {catchJobs.map((r) => `job ${r.job_number}`).join(', ')}</b>, the catch-all with no billing. The header's hours over target ({hours(summary.headerOverHours)}) includes them; this tab ranks sites only.</div>}
    {top.length ? <ChartCard title={`Hours over target: top ${top.length} sites`} height={Math.max(160, top.length * 24 + 50)}
      legend={<><Swatch color={t.warn} label="OT premium hours" /><Swatch color={t.bad} label="Extra hours" /></>}
      chart={<OverHoursChart labels={top.map((r) => shortName(r.site_name))} premium={top.map((r) => r.overFromOtPremium)} extra={top.map((r) => r.overFromExtraHours)} />}
      table={<table><thead><tr><th className="nosort l">Site</th><th className="nosort">OT premium hrs</th><th className="nosort">Extra hrs</th></tr></thead><tbody>{top.map((r) => <tr key={r.job_number}><td className="l">{r.site_name}</td><td>{hours1(r.overFromOtPremium)}</td><td>{hours1(r.overFromExtraHours)}</td></tr>)}</tbody></table>} />
      : <Empty>No site is over target this week.</Empty>}
    {o.rows.length > 0 && <div className="card"><SortTable caption="Sites over target" rows={o.rows} columns={cols} defaultSort={{ key: 'oh', dir: -1 }} onRowClick={open} rowLabel={(r) => `Open ${r.site_name}`} csvName={`${account.slug}-over-target`} /></div>}
  </>
}

function OvertimeTab({ account, summary }: { account: LeadershipAccount; summary: AccountSummary }) {
  const t = useTokens()
  const open = useSiteOpener()
  const o = summary.overtime
  const withOt = summary.sites.filter((r) => r.ot_hours > 0)
  const top = [...summary.sites].sort((a, b) => b.ot_hours - a.ot_hours).filter((r) => r.ot_hours > 0).slice(0, 15)
  const unbilled = summary.sites.filter((r) => r.role !== 'site').map((r) => r.job_number)
  const cols: Column<SiteMetrics>[] = [
    { key: 'job', header: 'Job', left: true, value: (r) => r.job_number },
    { key: 'name', header: 'Location', left: true, value: (r) => r.site_name, className: 'nm' },
    { key: 'seg', header: 'Segment', left: true, value: (r) => r.segment ?? (r.role === 'catch_all' ? 'Catch-all' : 'Non-billed'), render: (r) => <span className="neutral">{r.segment ?? (r.role === 'catch_all' ? 'Catch-all' : 'Non-billed')}</span> },
    { key: 'hrs', header: 'Hours', value: (r) => r.hours, render: (r) => hours1(r.hours) },
    { key: 'oth', header: 'OT hrs', value: (r) => r.ot_hours, render: (r) => hours1(r.ot_hours) },
    { key: 'otp', header: 'OT %', value: (r) => r.otPct, render: (r) => <span className={r.otPct > 0.25 ? 'bad' : r.otPct > 0.15 ? 'warn' : ''}>{pct(r.otPct)}</span> },
    { key: 'otd', header: 'OT $', value: (r) => r.ot_dollars, render: (r) => money(r.ot_dollars) },
    { key: 'pr', header: 'Premium $', value: (r) => r.otPremiumDollars, render: (r) => money(r.otPremiumDollars) },
    { key: 'lp', header: measureLabel(account), value: (r) => r.measurePct, render: (r) => <span className={toneOf(r.status)}>{pct(r.measurePct)}</span> },
  ]
  return <>
    <div className="kpi-lg">
      <Kpi label="OT hours" value={hours(o.hours)} sub={`${pct(o.pctOfHours)} of all hours`} tone={o.pctOfHours > 0.1 ? 'warn' : ''} />
      <Kpi label="OT dollars" value={money(o.dollars)} sub={`${pct(o.pctOfLabor)} of labor $`} />
      <Kpi label="OT premium cost" value={money(o.premiumDollars)} sub="The half-time portion only" tone="bad" />
      <Kpi label="Locations with OT" value={o.rowsWithOt} sub={`of ${o.rowsWithLabor} with labor`} />
      <Kpi label="Catch-all + non-billed OT" value={hours(o.unbilledOtHours)} sub={unbilled.length ? `OT hours in jobs ${unbilled.join(', ')}` : 'None configured'} tone={o.unbilledOtHours > 0 ? 'warn' : ''} />
    </div>
    {top.length ? <ChartCard title={`OT hours by site: top ${top.length}`} height={Math.max(160, top.length * 24 + 50)}
      legend={<><Swatch color={t.warn} label="OT hours" /><Swatch color={t.bad} label="Over 25% of hours" /><Swatch color={t.muted} label="Catch-all or non-billed" /></>}
      chart={<OtHoursChart labels={top.map((r) => shortName(r.site_name))} values={top.map((r) => r.ot_hours)} tones={top.map((r) => (r.role !== 'site' ? 'muted' : r.otPct > 0.25 ? 'bad' : 'warn'))}
        details={top.map((r) => `${r.ot_hours.toFixed(1)} OT hrs, ${pct(r.otPct)} of hours, ${money(r.ot_dollars)}`)} />}
      table={<table><thead><tr><th className="nosort l">Site</th><th className="nosort">OT hrs</th><th className="nosort">OT %</th><th className="nosort">OT $</th></tr></thead><tbody>{top.map((r) => <tr key={r.job_number}><td className="l">{r.site_name}</td><td>{hours1(r.ot_hours)}</td><td>{pct(r.otPct)}</td><td>{money(r.ot_dollars)}</td></tr>)}</tbody></table>} />
      : <Empty>No overtime this week.</Empty>}
    {withOt.length > 0 && <div className="card"><SortTable caption="Sites with overtime" rows={withOt} columns={cols} defaultSort={{ key: 'oth', dir: -1 }} rowClass={(r) => (r.role !== 'site' ? 'dim' : '')} onRowClick={open} rowLabel={(r) => `Open ${r.site_name}`} csvName={`${account.slug}-overtime`} /></div>}
  </>
}

export function Account() {
  const { selectedAccount: account, route, navigate, weekStart, optionsFor, config } = useLeadership()
  const tab = route.tab ?? 'overview'
  const rowsQuery = useRows(account?.slug, 1)
  const rows = useMemo(() => rowsOfWeek(rowsQuery.data?.rows, weekStart), [rowsQuery.data, weekStart])
  const options = useMemo(() => optionsFor(account), [optionsFor, account])
  const summary = useMemo(() => (account && rows.length ? accountSummary(rows, options, segmentOrder(account)) : null), [account, rows, options])
  const flags = useMemo(() => dataFlags(config.data, weekStart, rows), [config.data, weekStart, rows])
  const priorShort = monthShort(rows.find((r) => r.revenue_month)?.revenue_month)
  const subtitle = [weekStart ? weekLabel(weekStart) : null, freshnessLine(config.data)].filter(Boolean).join('. ')
  const setTab = (next: AccountTab) => navigate({ view: 'account', account: account?.slug, tab: next })
  let body
  if (rowsQuery.error) body = <LoadError error={rowsQuery.error} onRetry={rowsQuery.refetch} />
  else if (!rowsQuery.data || !account) body = <Skeleton height={360} />
  else if (tab === 'vendors') body = <Vendors account={account} />
  else if (!summary) body = <Empty>No rows for {account.name} in the selected week.</Empty>
  else if (tab === 'overview') body = <Overview account={account} rows={rows} summary={summary} options={options} flags={flags} />
  else if (tab === 'sites') body = <SitesTab account={account} summary={summary} priorShort={priorShort} />
  else if (tab === 'over-target') body = <OverTargetTab account={account} summary={summary} options={options} priorShort={priorShort} />
  else if (tab === 'overtime') body = <OvertimeTab account={account} summary={summary} />
  else body = <Suspense fallback={<Skeleton height={520} />}><SiteMap account={account} summary={summary} /></Suspense>
  return <>
    <PageHeader title={account ? `${account.name} Labor P&L` : 'Account'} subtitle={subtitle} />
    <nav className="tabs" role="tablist" aria-label="Account views">
      {ACCOUNT_TABS.map((t) => <button key={t} type="button" role="tab" className="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{TAB_LABEL[t]}</button>)}
    </nav>
    <section role="tabpanel" aria-label={TAB_LABEL[tab]}>{body}</section>
    {route.site && <SiteDrawer company={route.site.company} job={route.site.job} />}
  </>
}
