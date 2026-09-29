import { lazy, Suspense, useMemo, useState } from 'react'
import type { LeadershipAccount, LeadershipRow } from '../../services/apiTypes'
import { ChartCard, Swatch } from '../ui'
import { OtHoursChart, useTokens } from '../charts'
import { dataFlags, includesVendor, rowsOfWeek, segmentLabel, segmentOrder, useRows, vendorLabel } from '../data'
import { hours, hours1, money, pct } from '../format'
import { accountSummary, type AccountSummary as Summary, type MetricOptions, type SiteMetrics as Metrics } from '../metrics'
import { Overview } from '../Overview'
import { ACCOUNT_TABS, monthShort, weekLabel, type AccountTab } from '../routes'
import { PageHeader, updatedLine } from '../Shell'
import { useLeadership } from '../state'
import { Badge, Empty, Kpi, LoadError, Pills, Skeleton, SortTable, toneOf, type Column } from '../ui'
import { HoursToCut } from './HoursToCut'
import { SiteDrawer } from './SiteDrawer'
import { Vendors } from './Vendors'

type AccountSummary = Summary<LeadershipRow>
type SiteMetrics = Metrics<LeadershipRow>

const SiteMap = lazy(() => import('./SiteMap'))

/** Subcontracted: marked so, or no delivery model recorded and only vendor cost (no hours) this week. */
const isSubcontracted = (r: LeadershipRow) => r.delivery_model === 'subcontracted' || (r.delivery_model == null && !r.hours && (r.sub_week ?? 0) > 0)

const TAB_LABEL: Record<AccountTab, string> = { overview: 'Overview', sites: 'Sites', 'over-target': 'Hours to cut', overtime: 'Overtime', map: 'Map', vendors: 'Vendors' }
const shortName = (name: string) => name.replace(/^[A-Z][A-Za-z]+ ?- ?/, '').replace(/ (Elementary|Middle|High) School$/, ' $1').replace(' Senior High School', ' Sr High')

export const roleBadge = (r: Metrics) => (r.role === 'catch_all' ? <Badge status="none" label="Catch-all" /> : r.role === 'non_billed' ? <Badge status="none" label="Non-billed" /> : <Badge status={r.status} />)

function useSiteOpener() {
  const { navigate } = useLeadership()
  return (r: LeadershipRow) => navigate({ site: { company: r.company ?? '', job: r.job_number } })
}

function SitesTab({ account, summary, priorShort, selfOnly }: { account: LeadershipAccount; summary: AccountSummary; priorShort: string; selfOnly: boolean }) {
  const [filter, setFilter] = useState('All')
  const open = useSiteOpener()
  const hasCatch = summary.sites.some((r) => r.role === 'catch_all')
  const hasNb = summary.sites.some((r) => r.role === 'non_billed')
  const vendor = includesVendor(account) && !selfOnly
  const options = ['All', ...summary.segments.map((s) => s.segment), ...(hasCatch ? ['Catch-all'] : []), ...(hasNb ? ['Non-billed'] : [])]
  const rows = summary.sites.filter((r) => filter === 'All' || (filter === 'Catch-all' ? r.role === 'catch_all' : filter === 'Non-billed' ? r.role === 'non_billed' : r.segment === filter && r.role === 'site'))
  // The weekly report's site breakdown: Budget is total labor allowed at target; $ Var is total labor
  // minus budget (in parentheses when under).
  const budget = (r: SiteMetrics) => (r.invoice > 0 ? r.invoice * r.target : null)
  const variance = (r: SiteMetrics) => (r.invoice > 0 ? r.cost - r.invoice * r.target : null)
  const cols: Column<SiteMetrics>[] = [
    { key: 'job', header: 'Job', left: true, value: (r) => r.job_number },
    { key: 'name', header: 'Site', left: true, value: (r) => r.site_name, className: 'nm' },
    { key: 'inv', header: 'Invoicing', value: (r) => r.invoice, render: (r) => money(r.invoice) },
    { key: 'lab', header: 'Direct labor', value: (r) => r.labor, render: (r) => money(r.labor) },
    ...(vendor ? [
      { key: 'ven', header: vendorLabel(account), value: (r: SiteMetrics) => r.vendor, render: (r: SiteMetrics) => money(r.vendor) },
      { key: 'tot', header: 'Total labor', value: (r: SiteMetrics) => r.cost, render: (r: SiteMetrics) => money(r.cost) },
    ] : []),
    { key: 'lp', header: 'Labor %', value: (r) => r.measurePct, render: (r) => <span className={toneOf(r.status)}>{pct(r.measurePct)}</span> },
    { key: 'prior', header: `${priorShort} actual`, value: (r) => r.priorLaborPct, render: (r) => <span className="neutral">{pct(r.priorLaborPct)}</span> },
    { key: 'bud', header: 'Budget', value: budget, render: (r) => <span className="neutral">{money(budget(r))}</span> },
    { key: 'var', header: '$ Var', value: variance, render: (r) => { const v = variance(r); return <span className={v == null ? '' : v > 0 ? 'bad' : 'ok'}>{money(v)}</span> } },
    { key: 'hrs', header: 'Hours', value: (r) => r.hours, render: (r) => hours1(r.hours) },
    { key: 'oth', header: 'OT hrs', value: (r) => r.ot_hours, render: (r) => hours1(r.ot_hours) },
    { key: 'otp', header: 'OT %', value: (r) => r.otPct, render: (r) => <span className={r.otPct > 0.25 ? 'bad' : r.otPct > 0.15 ? 'warn' : ''}>{pct(r.otPct)}</span> },
    { key: 'st', header: 'Status', value: (r) => r.measurePct, render: roleBadge, csv: (r) => (r.role === 'site' ? r.status : r.role) },
  ]
  const s = accountSummary(rows, { target: 0 }, [])
  const sum = (f: (r: SiteMetrics) => number | null) => rows.reduce((a, r) => a + (f(r) ?? 0), 0)
  const cost = sum((r) => r.cost)
  const totalVar = sum(variance)
  const tot = <tr className="tot"><td></td><td className="l">Total ({rows.length})</td><td>{money(s.all.invoice)}</td><td>{money(s.all.labor)}</td>
    {vendor && <><td>{money(sum((r) => r.vendor))}</td><td>{money(cost)}</td></>}
    <td>{pct(cost / (s.all.invoice || NaN))}</td><td className="neutral">{pct(s.all.priorLaborPct)}</td><td className="neutral">{money(sum(budget))}</td>
    <td className={totalVar > 0 ? 'bad' : 'ok'}>{money(totalVar)}</td><td>{hours1(s.all.hours)}</td><td>{hours1(s.all.otHours)}</td><td>{pct(s.all.otPct)}</td><td></td></tr>
  return <>
    <Pills label="Filter sites" options={options.map((o) => ({ value: o, label: o }))} value={filter} onChange={setFilter} />
    <div className="card"><SortTable caption={`${account.name} sites`} rows={rows} columns={cols} defaultSort={{ key: 'lp', dir: -1 }} total={tot}
      rowClass={(r) => (r.role !== 'site' ? 'dim' : '')} onRowClick={open} rowLabel={(r) => `Open ${r.site_name}`} csvName={`${account.slug}-sites`} /></div>
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
    { key: 'name', header: 'Site', left: true, value: (r) => r.site_name, className: 'nm' },
    { key: 'seg', header: segmentLabel(account), left: true, value: (r) => r.segment ?? (r.role === 'catch_all' ? 'Catch-all' : 'Non-billed'), render: (r) => <span className="neutral">{r.segment ?? (r.role === 'catch_all' ? 'Catch-all' : 'Non-billed')}</span> },
    { key: 'hrs', header: 'Hours', value: (r) => r.hours, render: (r) => hours1(r.hours) },
    { key: 'oth', header: 'OT hrs', value: (r) => r.ot_hours, render: (r) => hours1(r.ot_hours) },
    { key: 'otp', header: 'OT %', value: (r) => r.otPct, render: (r) => <span className={r.otPct > 0.25 ? 'bad' : r.otPct > 0.15 ? 'warn' : ''}>{pct(r.otPct)}</span> },
    { key: 'otd', header: 'OT cost', value: (r) => r.ot_dollars, render: (r) => money(r.ot_dollars) },
    { key: 'pr', header: 'OT premium', value: (r) => r.otPremiumDollars, render: (r) => money(r.otPremiumDollars) },
    { key: 'lp', header: 'Labor %', value: (r) => r.measurePct, render: (r) => <span className={toneOf(r.status)}>{pct(r.measurePct)}</span> },
  ]
  return <>
    <div className="kpi-lg">
      <Kpi label="OT hours" value={hours(o.hours)} sub={`${pct(o.pctOfHours)} of all hours`} tone={o.pctOfHours > 0.1 ? 'warn' : ''} />
      <Kpi label="OT cost" value={money(o.dollars)} sub={`${pct(o.pctOfLabor)} of labor`} />
      <Kpi label="OT premium" value={money(o.premiumDollars)} sub="Half-time portion" tone="bad" />
      <Kpi label="Sites with OT" value={o.rowsWithOt} sub={`of ${o.rowsWithLabor} with labor`} />
      <Kpi label="Catch-all and non-billed OT" value={hours(o.unbilledOtHours)} sub={unbilled.length ? `Jobs ${unbilled.join(', ')}` : undefined} tone={o.unbilledOtHours > 0 ? 'warn' : ''} />
    </div>
    {top.length ? <ChartCard title={`OT hours, top ${top.length}`} height={Math.max(160, top.length * 24 + 50)}
      legend={<><Swatch color={t.warn} label="OT hours" /><Swatch color={t.bad} label="Over 25% of hours" /><Swatch color={t.muted} label="Catch-all or non-billed" /></>}
      chart={<OtHoursChart labels={top.map((r) => shortName(r.site_name))} values={top.map((r) => r.ot_hours)} tones={top.map((r) => (r.role !== 'site' ? 'muted' : r.otPct > 0.25 ? 'bad' : 'warn'))}
        details={top.map((r) => `${r.ot_hours.toFixed(1)} OT hrs, ${pct(r.otPct)} of hours, ${money(r.ot_dollars)}`)} />}
      table={<table><thead><tr><th className="nosort l">Site</th><th className="nosort">OT hrs</th><th className="nosort">OT %</th><th className="nosort">OT cost</th></tr></thead><tbody>{top.map((r) => <tr key={r.job_number}><td className="l">{r.site_name}</td><td>{hours1(r.ot_hours)}</td><td>{pct(r.otPct)}</td><td>{money(r.ot_dollars)}</td></tr>)}</tbody></table>} />
      : <Empty>No overtime this week.</Empty>}
    {withOt.length > 0 && <div className="card"><SortTable caption="Sites with overtime" rows={withOt} columns={cols} defaultSort={{ key: 'oth', dir: -1 }} rowClass={(r) => (r.role !== 'site' ? 'dim' : '')} onRowClick={open} rowLabel={(r) => `Open ${r.site_name}`} csvName={`${account.slug}-overtime`} /></div>}
  </>
}

export function Account() {
  const { selectedAccount: account, route, navigate, weekStart, optionsFor, config } = useLeadership()
  const tab = route.tab ?? 'overview'
  const rowsQuery = useRows(account?.slug, 1)
  const weekRows = useMemo(() => rowsOfWeek(rowsQuery.data?.rows, weekStart), [rowsQuery.data, weekStart])
  const subcontracted = weekRows.filter(isSubcontracted).length
  const selfOnly = Boolean(route.selfOnly) && subcontracted > 0
  const rows = useMemo(() => (selfOnly ? weekRows.filter((r) => !isSubcontracted(r)) : weekRows), [weekRows, selfOnly])
  const options = useMemo(() => optionsFor(account), [optionsFor, account])
  const summary = useMemo(() => (account && rows.length ? accountSummary(rows, options, segmentOrder(account)) : null), [account, rows, options])
  const flags = useMemo(() => dataFlags(config.data, weekStart, rows), [config.data, weekStart, rows])
  const priorShort = monthShort(rows.find((r) => r.revenue_month)?.revenue_month)
  const subtitle = [weekStart ? weekLabel(weekStart) : null, updatedLine(config.data)].filter(Boolean).join('. ')
  const setTab = (next: AccountTab) => navigate({ view: 'account', account: account?.slug, tab: next })
  let body
  if (rowsQuery.error) body = <LoadError error={rowsQuery.error} onRetry={rowsQuery.refetch} />
  else if (!rowsQuery.data || !account) body = <Skeleton height={360} />
  else if (tab === 'vendors') body = <Vendors account={account} />
  else if (!summary) body = <Empty>No data for this week.</Empty>
  else if (tab === 'overview') body = <Overview account={account} rows={rows} summary={summary} options={options} flags={flags} />
  else if (tab === 'sites') body = <SitesTab account={account} summary={summary} priorShort={priorShort} selfOnly={selfOnly} />
  else if (tab === 'over-target') body = <HoursToCut account={account} summary={summary} options={options} />
  else if (tab === 'overtime') body = <OvertimeTab account={account} summary={summary} />
  else body = <Suspense fallback={<Skeleton height={520} />}><SiteMap account={account} summary={summary} /></Suspense>
  return <>
    <PageHeader title={account ? `${account.name} Labor P&L` : 'Account'} subtitle={subtitle}
      extra={subcontracted > 0 && tab !== 'vendors' && <label className="check"><input type="checkbox" checked={selfOnly}
        onChange={(e) => navigate({ selfOnly: e.target.checked || undefined }, { replace: true })} />Hide {subcontracted} subcontracted</label>} />
    <nav className="tabs" role="tablist" aria-label="Account views">
      {ACCOUNT_TABS.map((t) => <button key={t} type="button" role="tab" className="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t === 'vendors' ? vendorLabel(account) : TAB_LABEL[t]}</button>)}
    </nav>
    <section role="tabpanel" aria-label={tab === 'vendors' ? vendorLabel(account) : TAB_LABEL[tab]}>{body}</section>
    {route.site && <SiteDrawer company={route.site.company} job={route.site.job} />}
  </>
}
