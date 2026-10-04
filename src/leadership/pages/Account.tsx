import { lazy, Suspense, useMemo } from 'react'
import type { LeadershipAccount, LeadershipRow } from '../../services/apiTypes'
import { ChartCard, Swatch } from '../ui'
import { OtHoursChart, OtWeekChart, useTokens } from '../charts'
import { Feedback, FeedbackTile } from './Feedback'
import { BudgetTab } from './Budget'
import { useApiQuery } from '../../hooks/useApiQuery'
import { queryKey } from '../../services/queryClient'
import type { LeadershipBudgetResponse, LeadershipFeedbackResponse } from '../../services/apiTypes'
import { dataFlags, daysInMonth, weekBudgetOf, isSubcontracted, monthFlags, rowsOfWeek, segmentLabel, segmentOrder, useMonthly, useMonthRows, useRows, vendorLabel } from '../data'
import { hours, hours1, money, pct } from '../format'
import { accountSummary, type AccountSummary as Summary, type SiteMetrics as Metrics } from '../metrics'
import { Overview } from '../Overview'
import { ACCOUNT_TABS, monthLabel, weekEndOf, weekLabel, weekTick, type AccountTab } from '../routes'
import { PageHeader, updatedLine } from '../Shell'
import { useLeadership } from '../state'
import { Empty, Kpi, LoadError, Skeleton, SortTable, toneOf, VocabContext, type Column } from '../ui'
import { HoursToCut } from './HoursToCut'
import { IncomeStatementTab, PalletTab, SubcontractedTab } from './ReportViews'
import { Sites } from './Sites'
import { tabLabel, tabsFor, vocabOf } from '../vocab'
import { SiteDrawer } from './SiteDrawer'
import { Vendors } from './Vendors'

type AccountSummary = Summary<LeadershipRow>
type SiteMetrics = Metrics<LeadershipRow>

const SiteMap = lazy(() => import('./SiteMap'))


const shortName = (name: string) => name.replace(/^[A-Z][A-Za-z]+ ?- ?/, '').replace(/ (Elementary|Middle|High) School$/, ' $1').replace(' Senior High School', ' Sr High')

function useSiteOpener() {
  const { navigate } = useLeadership()
  return (r: LeadershipRow) => navigate({ site: { company: r.company ?? '', job: r.job_number } })
}


function OvertimeTab({ account, summary }: { account: LeadershipAccount; summary: AccountSummary }) {
  const t = useTokens()
  const open = useSiteOpener()
  const { monthMode, navigate, weekStart } = useLeadership()
  const o = summary.overtime
  // OT by week over 13 weeks, catch-all included, non-billed events left out (as the weekly report).
  const history = useRows(account.slug, 13)
  const byWeek = useMemo(() => (history.data?.weeks ?? []).map((wk) => {
    const wr = rowsOfWeek(history.data?.rows, wk).filter((r) => r.role !== 'non_billed')
    const hrs = wr.reduce((x, r) => x + r.hours, 0), ot = wr.reduce((x, r) => x + r.ot_hours, 0)
    return { week: wk, ot, pct: hrs > 0 ? ot / hrs : null, dollars: wr.reduce((x, r) => x + (r.ot_dollars ?? 0), 0) }
  }), [history.data])
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
      : <Empty>No overtime this {monthMode ? 'month' : 'week'}.</Empty>}
    {byWeek.length > 1 && <ChartCard title="OT by week" height={240}
      legend={<><Swatch color={t.warn} label="OT hours" /><Swatch color={t.bad} label="OT % of hours" /></>}
      chart={<OtWeekChart labels={byWeek.map((x) => weekTick(x.week))} otHours={byWeek.map((x) => x.ot)} otPct={byWeek.map((x) => x.pct)} otDollars={byWeek.map((x) => x.dollars)}
        current={byWeek.findIndex((x) => x.week === weekStart)} onPick={(i) => navigate({ week: weekEndOf(byWeek[i].week), period: undefined, month: undefined }, { replace: true })} />}
      table={<table><thead><tr><th className="nosort l">Week ending</th><th className="nosort">OT hrs</th><th className="nosort">OT %</th><th className="nosort">OT cost</th></tr></thead>
        <tbody>{byWeek.map((x) => <tr key={x.week}><td className="l">{weekTick(x.week)}</td><td>{hours1(x.ot)}</td><td>{pct(x.pct)}</td><td>{money(x.dollars)}</td></tr>)}</tbody></table>} />}
    {withOt.length > 0 && <div className="card"><SortTable caption="Sites with overtime" rows={withOt} columns={cols} defaultSort={{ key: 'oth', dir: -1 }} rowClass={(r) => (r.role !== 'site' ? 'dim' : '')} onRowClick={open} rowLabel={(r) => `Open ${r.site_name}`} csvName={`${account.slug}-overtime`} /></div>}
  </>
}

export function Account() {
  const { selectedAccount: account, route, navigate, weekStart, optionsFor, config, monthMode, month, can } = useLeadership()
  const tab = route.tab ?? 'overview'
  const weekQuery = useRows(monthMode ? undefined : account?.slug, 1)
  // The same request with split-out subcontracted sites kept: the Pallet tab lists those billing pallet work.
  const fullWeek = useRows(monthMode ? undefined : account?.slug, 1, { keepSubcontracted: true })
  const monthQuery = useMonthRows(monthMode ? account?.slug : undefined, monthMode ? month : undefined)
  const rowsQuery = monthMode ? monthQuery : weekQuery
  const weekRows = useMemo(() => (monthMode ? monthQuery.data?.rows ?? [] : rowsOfWeek(weekQuery.data?.rows, weekStart)), [monthMode, monthQuery.data, weekQuery.data, weekStart])
  const subcontracted = weekRows.filter((r) => isSubcontracted(r, account)).length
  const selfOnly = Boolean(route.selfOnly) && subcontracted > 0
  const rows = useMemo(() => (selfOnly ? weekRows.filter((r) => !isSubcontracted(r, account)) : weekRows), [weekRows, selfOnly, account])
  const { api, keyPrefix, decision } = useLeadership()
  const budget = useApiQuery<LeadershipBudgetResponse>(decision && account && can('tab.budget') ? queryKey(`${keyPrefix}/leadership/budget`, { account: account.slug }) : null,
    (signal) => api.leadershipBudget(account!.slug, signal), [api, account?.slug])
  const budgetWeeks = budget.data?.weeks
  const budgetMonths = budget.data?.months
  const payHolidays = Boolean(route.payHolidays)
  const weekBudget = !monthMode && weekStart ? weekBudgetOf(weekStart, budgetWeeks, budgetMonths, payHolidays) : null
  const options = useMemo(() => {
    if (monthMode && month) return { ...optionsFor(account), revenueMethod: 'weekly_billing' as const, period: 'month' as const, periodDays: daysInMonth(month) }
    const base = optionsFor(account)
    // The week's target is its budget labor over its invoice (the weekly budget calendar), unless a target is typed in.
    if (!weekBudget || route.target != null || !account || !rows.length) return base
    const invoice = accountSummary(rows, base, []).all.invoice
    return invoice > 0 ? { ...base, target: weekBudget.labor / invoice } : base
  }, [optionsFor, account, monthMode, month, weekBudget, route.target, rows, payHolidays])
  const summary = useMemo(() => (account && rows.length ? accountSummary(rows, options, segmentOrder(account)) : null), [account, rows, options])
  const flags = useMemo(() => (monthMode && month ? monthFlags(config.data, month, rows) : dataFlags(config.data, weekStart, rows)), [config.data, weekStart, rows, monthMode, month])
  const subtitle = [monthMode && month ? monthLabel(`${month}-01`) : weekStart ? weekLabel(weekStart) : null, updatedLine(config.data)].filter(Boolean).join('. ')
  const setTab = (next: AccountTab) => navigate({ view: 'account', account: account?.slug, tab: next })
  const monthly = useMonthly(account?.slug)
  const feedback = useApiQuery<LeadershipFeedbackResponse>(decision && account && can('tab.feedback') ? queryKey(`${keyPrefix}/leadership/feedback`, { account: account.slug, months: 12 }) : null,
    (signal) => api.leadershipFeedback(account!.slug, 12, signal), [api, account?.slug])
  const tabs = tabsFor(account, ACCOUNT_TABS, {
    feedback: Boolean(feedback.data?.lines.length),
    budget: Boolean(budget.data?.months.length),
    pallet: rows.some((r) => (r.kids?.length ?? 1) > 1),
    subcontracted: Boolean(account?.split_subcontracted) || subcontracted > 0,
    incomeStatement: Boolean(account?.split_subcontracted) || Object.keys(monthly.data?.income_statement ?? {}).length > 0,
  }).filter((t) => (!monthMode || t !== 'over-target') && (t === 'overview' || can(`tab.${t}`)))
  const vocab = vocabOf(account)
  let body
  if (rowsQuery.error) body = <LoadError error={rowsQuery.error} onRetry={rowsQuery.refetch} />
  else if (!rowsQuery.data || !account) body = <Skeleton height={360} />
  else if (tab === 'vendors') body = <Vendors account={account} />
  else if (tab === 'feedback' && tabs.includes(tab)) body = <Feedback account={account} />
  else if (tab === 'budget' && tabs.includes(tab)) body = <BudgetTab account={account} />
  else if (tab === 'subcontracted' && tabs.includes(tab)) body = <SubcontractedTab account={account} />
  else if (tab === 'income-statement' && tabs.includes(tab)) body = <IncomeStatementTab account={account} options={options} />
  else if (!summary) body = <Empty>No data for this {monthMode ? 'month' : 'week'}.</Empty>
  else if (tab === 'pallet' && tabs.includes(tab)) body = <PalletTab account={account} summary={summary} options={options}
    subcontracted={(monthMode ? rows : rowsOfWeek(fullWeek.data?.rows, weekStart)).filter((r) => isSubcontracted(r, account))} />
  else if (tab === 'overview' || !tabs.includes(tab)) body = <Overview account={account} rows={rows} summary={summary} options={options} flags={flags}
    budgetWeeks={budgetWeeks} budgetMonths={budgetMonths} payHolidays={payHolidays}
    afterGroups={can('tab.feedback') && <FeedbackTile account={account} month={monthMode ? month : weekStart ? weekEndOf(weekStart).slice(0, 7) : undefined} />} />
  else if (tab === 'sites') body = <Sites account={account} summary={summary} options={options} selfOnly={selfOnly} ratings={feedback.data?.by_site} />
  else if (tab === 'over-target') body = <HoursToCut account={account} summary={summary} options={options} />
  else if (tab === 'overtime') body = <OvertimeTab account={account} summary={summary} />
  else body = <Suspense fallback={<Skeleton height={520} />}><SiteMap account={account} summary={summary} /></Suspense>
  const basis = options.invoiceBasis ?? 'last_month'
  const basisControl = !monthMode && account?.revenue_method !== 'weekly_billing' && tab !== 'vendors' && tab !== 'feedback' && tab !== 'budget' && tab !== 'subcontracted' && tab !== 'income-statement' && <>
    <label htmlFor="basis">Invoice basis</label>
    <select id="basis" value={basis} onChange={(e) => navigate({ basis: e.target.value === account?.invoice_basis ? undefined : e.target.value as 'run_rate_3m' | 'last_month' }, { replace: true })}>
      <option value="run_rate_3m">3-month run rate</option><option value="last_month">{monthLabel(rows.find((r) => r.revenue_month)?.revenue_month ?? null)} actual</option>
    </select></>
  const current = tabs.includes(tab) ? tab : 'overview'
  return <VocabContext.Provider value={vocab}>
    <PageHeader title={account ? `${account.name} Labor P&L` : 'Account'} subtitle={subtitle} period
      defaultTarget={weekBudget && route.target == null && options.target !== optionsFor(account).target ? options.target : undefined}
      extra={<>{basisControl}{subcontracted > 0 && tab !== 'vendors' && tab !== 'feedback' && tab !== 'budget' && <label className="check"><input type="checkbox" checked={selfOnly}
        onChange={(e) => navigate({ selfOnly: e.target.checked || undefined }, { replace: true })} />Hide {subcontracted} subcontracted</label>}
        {!monthMode && (budgetWeeks?.some((x) => x.holiday > 0) ?? false) && <label className="check"><input type="checkbox" checked={payHolidays}
          onChange={(e) => navigate({ payHolidays: e.target.checked || undefined }, { replace: true })} />Pay stat holidays</label>}</>} />
    <nav className="tabs" role="tablist" aria-label="Account views">
      {tabs.map((t) => <button key={t} type="button" role="tab" className="tab" aria-selected={current === t} onClick={() => setTab(t)}>{tabLabel(t, account, vendorLabel(account))}</button>)}
    </nav>
    <section role="tabpanel" aria-label={tabLabel(current, account, vendorLabel(account))}>{body}</section>
    {route.site && <SiteDrawer company={route.site.company} job={route.site.job} />}
  </VocabContext.Provider>
}
