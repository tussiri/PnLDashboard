import { useMemo, type ReactNode } from 'react'
import type { BudgetMonth, BudgetWeek, LeadershipAccount, LeadershipMonthlyJob, LeadershipRow } from '../services/apiTypes'
import { Badge, ChartCard, Kpi, Skeleton, Swatch, toneOf, useVocab } from './ui'
import { LaborMixChart, MonthWeekTrendChart, SegmentTrendChart, SiteLpChart, useTokens } from './charts'
import { closedMonths, includesVendor, inSentence, isSubcontracted, monthLaborPct, monthRevenue, priorMonth, rowsOfWeek, segmentLabel, segmentOrder, siteMonths, useMonthly, useMonthRows, useRows, vendorLabel, weekBudgetOf, type DataFlags, type WeekBudget } from './data'
import { hours, hours1, money, moneyK, pct } from './format'
import { accountSummary, statusOf, type AccountNote, type AccountSummary, type MetricOptions, type SiteMetrics } from './metrics'
import { addDays, monthLabel, monthShort, TREND_WEEKS_DEFAULT, TREND_WEEKS_MAX, TREND_WEEKS_MIN, weekEndOf, weekTick } from './routes'
import { projectRecentWeeks, PROJECTION_BASE_WEEKS } from './projection'
import { QaCards } from './Qa'
import { useLeadership } from './state'
import { billingSources, invoiceLabel, weekChange, wordsFor } from './vocab'

const siteWord = (n: number) => `${n} site${n === 1 ? '' : 's'}`
/** Weeks of rows loaded per request for the trend (the API's maximum): about six months. */
const TREND_LOAD = 26
const SYNC_NAME: Record<string, string> = { winteam_sarus: 'Sarus', nightly: 'Nightly', relay: 'Relay', mail_inbox: 'Reports inbox' }

/** Facts that qualify the week's numbers: catch-all and non-billed jobs, estimates, allocation, stale or failed data. */
export function Notes({ summary, account, flags, options, revenueMonth, extra = [] }: { summary: AccountSummary<LeadershipRow>; account: LeadershipAccount; flags: DataFlags; options: MetricOptions; revenueMonth: string | null
  /** Facts the caller adds (the overview: a selected week whose labor is not in yet). */
  extra?: { tone: '' | 'warn' | 'bad'; key: string; label: string; body: ReactNode }[] }) {
  const items: { tone: '' | 'warn' | 'bad'; key: string; label: string; body: ReactNode }[] = []
  const add = (tone: '' | 'warn' | 'bad', key: string, label: string, body: ReactNode) => items.push({ tone, key, label, body })
  const effort = (labor: number, hrs: number, ot: number) => `${money(labor)}, ${hours(hrs)} hrs, ${hours(ot)} OT`
  for (const n of summary.notes as AccountNote[]) {
    if (n.kind === 'catch_all') add('', `c${n.job_number}`, `Job ${n.job_number} catch-all`, `${effort(n.labor, n.hours, n.otHours)}. Sites only ${pct(n.sitesLaborPct)}`)
    if (n.kind === 'non_billed') add('warn', `n${n.job_number}`, `Job ${n.job_number} non-billed`, `${effort(n.labor, n.hours, n.otHours)}. All-in labor % ${pct(n.allInLaborPct)}`)
    if (n.kind === 'billed_no_labor') add('', 'nolab', 'Billed, no cost', `${n.jobs.slice(0, 8).map((j) => `${j.job_number} ${j.site_name}`).join(', ')}${n.jobs.length > 8 ? `, ${n.jobs.length - 8} more` : ''}`)
    if (n.kind === 'budget_unreliable') add('', 'budget', 'Budget hours', `${pct(n.ratio)} of actual; reference only`)
    if (n.kind === 'labor_estimated') add('warn', 'est', 'Labor estimated', `${money(n.labor)} at ${siteWord(n.jobs)}; job-cost rate, no WinTeam pay rate`)
    if (n.kind === 'vendor_projected') add('warn', 'vproj', `${vendorLabel(account)} projected`, `${money(n.amount)} at ${siteWord(n.jobs)}; from contract or prior month`)
    if (n.kind === 'revenue_allocated') add('', 'alloc', 'Parent billing spread', `${money(n.amount)} over ${siteWord(n.jobs)} by ${n.weight === 'actual_hours' ? `${monthLabel(revenueMonth)} hours worked` : n.weight === 'week_hours' ? 'week hours' : `${monthLabel(revenueMonth)} budget hours`}`)
  }
  const payroll = summary.sites.filter((r) => r.labor > 0 && r.labor_basis === 'payroll_rate')
  if (payroll.length) add('', 'payroll', 'Labor source', `WinTeam hours at WinTeam pay rates, ${siteWord(payroll.length)}`)
  if (flags.revenueLag) add('bad', 'lag', 'Invoicing month', `${monthLabel(flags.revenueLag.revenueMonth)}; ${monthLabel(flags.revenueLag.expectedMonth)} job cost not loaded`)
  for (const s of flags.failedSyncs) add('bad', `s${s.integration}`, `${SYNC_NAME[s.integration] ?? 'WinTeam'} sync failed`, s.at ? s.at.slice(0, 10) : '')
  if (flags.weekInProgress) add('warn', 'prog', 'Week in progress', 'Partial hours and labor')
  for (const x of extra) add(x.tone, x.key, x.label, x.body)
  if (flags.month?.inProgress) add('warn', 'mprog', 'Month in progress', 'Partial hours and labor')
  if (flags.month?.subsExpected) add(flags.month.subsReceived < flags.month.subsExpected ? 'warn' : '', 'subs', 'Sub invoices', `${flags.month.subsReceived} of ${flags.month.subsExpected} received`)
  if (flags.month?.notInvoiced) add('warn', 'noinv', 'Not yet invoiced', `${siteWord(flags.month.notInvoiced)}; contract or prior month`)
  const w = wordsFor(account.vocabulary ?? 'amazon')
  const factor = account.vendor_factor ?? 1
  const vendorPart = includesVendor(account) ? ` + ${inSentence(vendorLabel(account))}${factor < 1 ? ` at ${Math.round(factor * 100)}%` : ''}` : ''
  add('', 'lp', 'Labor %', `(${w.direct} labor${summary.sites.some((r) => (r.pallet_labor ?? 0) > 0) ? ' + pallet' : ''}${vendorPart}) ÷ ${invoiceLabel(w, account.vocabulary ?? 'amazon', options.period).toLowerCase()}`)
  if (options.segmentTargets && Object.keys(options.segmentTargets).length) add('', 'segt', `${segmentLabel(account)} targets`, Object.entries(options.segmentTargets).map(([s, t]) => `${s} ${pct(t)}`).join(', '))
  if (!items.length) return null
  return <dl className="notes">{items.map((i) => <div key={i.key}><dt className={i.tone}>{i.label}</dt><dd>{i.body}</dd></div>)}</dl>
}

type Row = SiteMetrics<LeadershipRow>

export const palletOf = (r: Row) => r.pallet_labor ?? 0
export const directOf = (r: Row) => r.labor - palletOf(r)
/**
 * The week's variable (OS, pallet) invoice, when the Job Cost Analysis carries the revenue split. Only
 * accounts grouped by pallet sites read it: other accounts book ordinary billing to the same OS line
 * (the school districts bill everything there), so the split means nothing for them.
 */
export function variableWk(r: LeadershipRow, o: MetricOptions): number | null {
  if (!o.palletSplit) return null
  const monthly = o.invoiceBasis === 'run_rate_3m' ? r.variable_run_rate : r.revenue_month_variable
  return monthly == null ? null : monthly / (o.divisor ?? 4.33)
}
const short = (name: string) => name.replace(/^[A-Z][A-Za-z]+ ?- ?/, '').replace(', CA 94534', '').replace(' - Cargo Bldg', ' Cargo').replace(/ (Elementary|Middle|High) School$/, ' $1')

/** Monthly jobs in the labor views: sites, their pallet jobs and catch-all jobs (not split-out subcontracted sites). */
export const laborJobs = (account: LeadershipAccount, jobs: LeadershipMonthlyJob[]) =>
  jobs.filter((j) => j.role !== 'non_billed' && !(account.split_subcontracted && j.delivery_model === 'subcontracted'))

/** Every account's overview: headline figures, notes, one card per group, the trend, labor % by site and where the labor dollars went. */
export function Overview({ account, rows, summary, options, flags, headline = true, afterGroups, budgetWeeks, budgetMonths, payHolidays = false, footer }: { account: LeadershipAccount; rows: LeadershipRow[]; summary: AccountSummary<LeadershipRow>; options: MetricOptions; flags: DataFlags; headline?: boolean
  /** Rendered after the group cards (the account page puts customer feedback here). */
  afterGroups?: ReactNode
  /** The account's weekly budget calendar (Admin > Budgets): budget labor and target per week. */
  budgetWeeks?: BudgetWeek[]
  /** The monthly plan: a week without a calendar row takes its budget from it, spread over weekdays. */
  budgetMonths?: BudgetMonth[]
  /** Count each week's stat-holiday pay in its budget. */
  payHolidays?: boolean
  /** Rendered last (the account page puts the star rating matrix here). */
  footer?: ReactNode }) {
  const t = useTokens()
  const vocab = useVocab()
  const w = wordsFor(vocab)
  const target = options.target
  const factor = options.vendorFactor ?? 1
  const { optionsFor, monthMode, month, can, navigate, weekStart, route, config } = useLeadership()
  const hasBudget = Boolean(budgetWeeks?.length || budgetMonths?.length)
  const budgetOf = (weekStartIso: string): WeekBudget | null => weekBudgetOf(weekStartIso, budgetWeeks, budgetMonths, payHolidays)
  const period = options.period ?? 'week'
  const perDay = options.periodDays ?? 7
  // The trend is always weekly; the change is against the prior week, or the prior month in the rollup.
  const weekOptions = monthMode ? optionsFor(account) : options
  // The week trend: the last TREND_LOAD weeks load with the page; the TREND_LOAD before them only when the slider asks.
  const trendWeeks = route.trendWeeks ?? TREND_WEEKS_DEFAULT
  const history = useRows(monthMode ? undefined : account.slug, TREND_LOAD)
  const older = useRows(!monthMode && trendWeeks > TREND_LOAD ? account.slug : undefined, TREND_LOAD,
    { week: weekStart ? addDays(weekStart, -TREND_LOAD * 7) : undefined })
  const priorMonthQuery = useMonthRows(monthMode ? account.slug : undefined, month ? priorMonth(month) : undefined)
  const monthly = useMonthly(account.slug)
  const revenueMonth = rows.find((r) => r.revenue_month)?.revenue_month ?? null
  const a = summary.account
  const sites = summary.sites.filter((r) => r.role === 'site')
  const billed = sites.filter((r) => r.invoice > 0)
  const unbilled = sites.filter((r) => !(r.invoice > 0) && r.labor > 0)
  const catchJobs = summary.sites.filter((r) => r.role === 'catch_all')
  const nonBilled = summary.sites.filter((r) => r.role === 'non_billed')
  const palD = summary.sites.reduce((x, r) => x + palletOf(r), 0)
  const palHrs = summary.sites.reduce((x, r) => x + (r.pallet_hours ?? 0), 0)
  const variable = sites.some((r) => variableWk(r, options) != null) ? sites.reduce((x, r) => x + (variableWk(r, options) ?? 0), 0) : null
  const unbilledHours = unbilled.reduce((x, r) => x + r.hours + r.otPremiumHours, 0)
  const over = summary.headerOverHours + unbilledHours
  const accountStatus = statusOf(a.measurePct, target, options.watchBand)

  const loadedRows = useMemo(() => [...(older.data?.rows ?? []), ...(history.data?.rows ?? [])], [older.data, history.data])
  const weeks = useMemo(() => [...new Set([...(older.data?.weeks ?? []), ...(history.data?.weeks ?? [])])].sort().map((wk) => {
    const wr = rowsOfWeek(loadedRows, wk)
    const sum = wr.length ? accountSummary(wr, weekOptions, segmentOrder(account)) : null
    return { week: wk, rows: wr, s: sum?.account ?? null, sitesLp: sum?.billed.measurePct ?? null,
      segs: Object.fromEntries((sum?.segments ?? []).map((g) => [g.segment, g.rollup.measurePct])) as Record<string, number | null> }
  }), [older.data, history.data, loadedRows, weekOptions, account])
  const prevMonthRows = priorMonthQuery.data?.rows
  const prevWeek = weeks.find((x) => weekStart && x.week === addDays(weekStart, -7))
  const prev = monthMode
    ? (prevMonthRows?.length ? accountSummary(prevMonthRows, options, segmentOrder(account)).account : null)
    : prevWeek?.s ?? null
  // The prior period's rows (the week before, or the month before in the rollup), for the group cards' changes.
  const prevRows = monthMode ? prevMonthRows : prevWeek?.rows
  const closed = closedMonths(monthly.data)
  const lastClosed = closed.at(-1)
  const scopeJobs = useMemo(() => (monthly.data ? laborJobs(account, monthly.data.jobs) : []), [monthly.data, account])
  const actual = lastClosed ? monthLaborPct(scopeJobs, lastClosed, factor) : null
  const change = (cur: number | null, before: number | null | undefined, format: (v: number) => string) =>
    cur == null || before == null ? null : `${cur - before >= 0 ? '+' : '−'}${format(Math.abs(cur - before))} ${period === 'month' ? (vocab === 'fedex' ? 'vs prior month' : 'MoM') : vocab === 'fedex' ? 'vs prior wk' : 'WoW'}`
  const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join('; ')

  const basis = period === 'month' ? billingSources(summary.sites) : account.revenue_method === 'weekly_billing' ? null : options.invoiceBasis === 'run_rate_3m'
    ? (variable != null ? `Fixed ${moneyK(summary.all.invoice - variable)} + variable ${moneyK(variable)} run rate ÷ ${account.revenue_divisor}` : `3-month run rate ÷ ${account.revenue_divisor}`)
    : `${monthLabel(revenueMonth)} revenue ÷ ${account.revenue_divisor}`
  const laborParts = [palD > 0 ? `${w.direct} ${moneyK(a.labor - palD)} + pallet ${moneyK(palD)}` : null, a.vendor > 0 ? `${inSentence(vendorLabel(account))} ~${moneyK(a.vendor)}` : null,
    catchJobs.length ? `incl. ${moneyK(summary.catchAll.cost)} catch-all` : null].filter(Boolean).join(' + ')

  const groups = summary.segments.map((g) => ({ name: g.segment, list: sites.filter((r) => r.segment === g.segment), target: g.target }))
  // The prior period's OT cost per group card (null when the prior period is not loaded).
  const prevSummary = useMemo(() => (prevRows?.length ? accountSummary(prevRows, options, segmentOrder(account)) : null), [prevRows, options, account])
  const prevGroupOt = (name: string) => (prevSummary ? prevSummary.sites.filter((r) => r.role === 'site' && r.segment === name).reduce((x, r) => x + r.ot_dollars, 0) : null)
  const changeWord = period === 'month' ? (vocab === 'fedex' ? 'vs prior month' : 'MoM') : vocab === 'fedex' ? 'vs prior wk' : 'WoW'
  // The trend: weeks in the week view (the last trendWeeks up to the selected week); closed months, as monthly
  // totals, in the month rollup (up to the selected month).
  // The latest weeks while their labor is still arriving are drawn as a projection (projection.ts), labeled as such.
  const projected = useMemo(() => {
    const known = config.data?.weeks ?? []
    const latest = known.reduce((m, w) => (w.week_start > m ? w.week_start : m), '')
    const inProgress = new Set(known.filter((w) => w.in_progress).map((w) => w.week_start))
    return projectRecentWeeks(weeks.map((x) => ({ week: x.week, cost: x.s?.cost ?? null, invoice: x.s?.invoice ?? null, lp: x.s?.measurePct ?? null, sitesLp: x.sitesLp, segs: x.segs })),
      inProgress, latest ? (wk) => wk >= addDays(latest, -7) : undefined)
  }, [weeks, config.data])
  const shownWeeks = useMemo(() => projected.filter((x) => !weekStart || x.week <= weekStart).slice(-trendWeeks), [projected, weekStart, trendWeeks])
  const anyProjected = !monthMode && shownWeeks.some((x) => x.projected)
  const selectedProjected = !monthMode && shownWeeks.some((x) => x.week === weekStart && x.projected)
  const projectedFlags = anyProjected ? shownWeeks.map((x) => x.projected) : undefined
  const trendMonths = useMemo(() => (monthMode ? closed.filter((m) => !month || m.slice(0, 7) <= month) : []), [monthMode, closed, month])
  const monthTotals = (m: string, jobs: typeof scopeJobs) => {
    const inv = jobs.reduce((x, j) => x + monthRevenue(j.months[m], j.delivery_model === 'subcontracted'), 0)
    const lab = jobs.reduce((x, j) => x + (j.months[m]?.direct_labor ?? 0) + (j.months[m]?.subcontractors ?? 0) * factor, 0)
    return { inv, lab, lp: inv > 0 ? lab / inv : null }
  }
  const trend = monthMode
    ? trendMonths.map((m) => { const t = monthTotals(m, scopeJobs); return { key: m, label: monthShort(m), labor: t.lab, invoice: t.inv, lp: t.lp } })
    : shownWeeks.map((x) => ({ key: x.week, label: weekTick(x.week), labor: x.cost, invoice: x.invoice, lp: x.lp, projected: x.projected }))
  // The budget target: each week's budget labor over its invoice; each month's plan over its billing.
  const weekTargets = !hasBudget ? undefined : monthMode
    ? trendMonths.map((m, i) => { const b = budgetMonths?.find((x) => x.month.slice(0, 7) === m.slice(0, 7)); return b && trend[i].invoice ? b.budget.total / trend[i].invoice! : null })
    : shownWeeks.map((x) => { const b = budgetOf(x.week); return b && x.invoice ? b.labor / x.invoice : null })
  // Sites only: the billed sites without the catch-all and non-billed jobs (shown when the account has those).
  const sitesLp = !(catchJobs.length || nonBilled.length) ? undefined : monthMode
    ? trendMonths.map((m) => monthTotals(m, scopeJobs.filter((j) => j.role === 'site')).lp)
    : shownWeeks.map((x) => x.sitesLp)
  // Labor % by group over the same points as the trend: each week's segment rollup, or each month's job cost.
  const segSeries = groups.map((g) => ({ name: g.name, target: g.target, values: monthMode
    ? trendMonths.map((m) => (monthly.data ? monthLaborPct(g.list.flatMap((r) => siteMonths(monthly.data!.jobs, r.company, r.kids, r.job_number)), m, factor) : null))
    : shownWeeks.map((x) => x.segs[g.name] ?? null) }))
  const pickPoint = (i: number) => { const x = trend[i]; if (!x) return; navigate(monthMode ? { period: 'month', month: x.key.slice(0, 7) } : { week: weekEndOf(x.key) }, { replace: true }) }
  const weeksSlider = !monthMode && <label className="slider"><span>Weeks</span>
    <input type="range" min={TREND_WEEKS_MIN} max={TREND_WEEKS_MAX} step={1} value={trendWeeks} aria-label="Weeks in the trends"
      onChange={(e) => { const n = Number(e.target.value); navigate({ trendWeeks: n === TREND_WEEKS_DEFAULT ? undefined : n }, { replace: true }) }} />
    <output>{trendWeeks}</output></label>
  const trendCurrent = monthMode ? trend.findIndex((x) => month && x.key.slice(0, 7) === month) : trend.findIndex((x) => x.key === weekStart)
  const thisWeekBudget = period === 'week' && weekStart ? budgetOf(weekStart) : null
  const budgetWeek = thisWeekBudget?.labor ?? null
  const exEvents = summary.sites.filter((r) => r.role !== 'non_billed').reduce((x, r) => x + r.cost, 0)
  const dayText = (b: WeekBudget | null) => (!b ? '' : b.source === 'monthly' ? 'from the monthly plan' : Object.entries(b.details).filter(([, v]) => v).map(([k, v]) => `${v} ${({ school_days: 'school', staff_days: 'staff', closure_days: 'closure', summer_days: 'summer', stat_holidays: 'holiday' } as Record<string, string>)[k] ?? k}`).join(', '))
  // Labor % by site lists self-performed sites only: a subcontracted site has no labor of ours, just the subcontractor's
  // invoice (its AR against AP is on the Subcontracted tab). The month rollup carries them; the week view splits them out.
  const subSites = billed.filter((r) => isSubcontracted(r, account)).length
  const sorted = billed.filter((r) => !isSubcontracted(r, account)).sort((x, y) => (y.measurePct ?? 0) - (x.measurePct ?? 0))
  const mix = [...groups.map((g) => ({ name: g.name, list: g.list })), ...catchJobs.map((r) => ({ name: `Job ${r.job_number} catch-all`, list: [r] })), ...nonBilled.map((r) => ({ name: `Job ${r.job_number} non-billed`, list: [r] }))]
  const sum = (list: Row[], f: (r: Row) => number) => list.reduce((x, r) => x + f(r), 0)
  const groupLp = (list: Row[]) => (monthly.data && lastClosed ? monthLaborPct(list.flatMap((r) => siteMonths(monthly.data!.jobs, r.company, r.kids, r.job_number)), lastClosed, factor) : null)
  const subLabel = w.subCol(vendorLabel(account))

  return <>
    {headline && <div className="kpi-lg">
      <Kpi label={w.labor} value={money(a.cost)} sub={join(laborParts, change(a.cost, prev?.cost, money)) || undefined} />
      <Kpi label={invoiceLabel(w, vocab, period)} value={money(summary.all.invoice)} sub={basis || undefined} />
      <Kpi label={w.accountLaborPct} value={pct(a.measurePct)} tone={toneOf(accountStatus)}
        sub={join(`Target ${pct(target)}`, lastClosed ? `${monthLabel(lastClosed)} actual ${pct(actual)}` : null,
          a.measurePct != null && prev?.measurePct != null ? weekChange(a.measurePct - prev.measurePct, vocab, period) : null)} />
      <Kpi label={w.hours} value={hours(a.hours)} sub={join(`${hours(a.otHours)} OT/DT (${pct(a.otPct)})`, palHrs ? `pallet ${hours(palHrs)}` : null, change(a.hours, prev?.hours, hours))} />
      {can('data.allocations') && <Kpi label="Margin" value={money(a.margin)} tone={a.margin < 0 ? 'bad' : ''}
        sub={join(pct(a.marginPct), a.allocation > 0 ? `after ${moneyK(a.allocation)} alloc.` : null)} />}
      {budgetWeek != null && <Kpi label="Vs budget labor" value={`${exEvents - budgetWeek >= 0 ? '+' : '−'}${money(Math.abs(exEvents - budgetWeek))}`} tone={exEvents > budgetWeek ? 'bad' : 'ok'}
        sub={join(`Budget ${money(budgetWeek)}`, `${pct(Math.abs(exEvents / budgetWeek - 1))} ${exEvents > budgetWeek ? 'over' : 'under'}`,
          thisWeekBudget?.source === 'monthly' ? 'from the monthly plan' : thisWeekBudget?.holiday && !payHolidays ? 'stat holiday not paid' : null)} />}
      <Kpi label={w.hoursOver} value={hours(over)} tone={over > 0 ? 'bad' : 'ok'}
        sub={join(`${hours1(over / perDay)}/day`, w.over(summary.billed.over, billed.length))} />
    </div>}
    <Notes summary={summary} account={account} flags={flags} options={options} revenueMonth={revenueMonth}
      extra={selectedProjected && !flags.weekInProgress ? [{ tone: 'warn', key: 'proj', label: 'Labor not in yet', body: `Trend projected from the ${PROJECTION_BASE_WEEKS} weeks before` }] : []} />
    <div className="seg-grid">
      {groups.map((g) => {
        const s = accountSummary(g.list, options, []).billed
        const status = statusOf(s.measurePct, g.target, options.watchBand)
        const palG = sum(g.list, palletOf)
        const varG = g.list.some((r) => variableWk(r, options) != null) ? sum(g.list, (r) => variableWk(r, options) ?? 0) : null
        return <GroupCard key={g.name} name={g.name} sub={`${g.list.length} sites, ${s.over} over target`} badge={<Badge status={status} />}
          invoice={s.invoice} invoiceSub={varG != null ? `${moneyK(varG)} variable` : undefined} labor={s.cost} laborSub={palG ? `${moneyK(palG)} pallet` : undefined}
          lp={s.measurePct} lpTone={toneOf(status)} lpSub={lastClosed ? `${monthShort(lastClosed)} ${pct(groupLp(g.list))}` : undefined}
          otCost={sum(g.list, (r) => r.ot_dollars)} otPrior={prevGroupOt(g.name)} otHours={sum(g.list, (r) => r.ot_hours)} changeWord={changeWord} w={w} />
      })}
      {catchJobs.length > 0 && <GroupCard name="Catch-all" sub={catchJobs.map((r) => `Job ${r.job_number}`).join(', ')} badge={null} invoice={0} labor={summary.catchAll.cost}
        lp={null} lpTone="" otCost={summary.catchAll.otDollars} otPrior={prevSummary?.catchAll.otDollars ?? null} otHours={summary.catchAll.otHours} changeWord={changeWord} w={w} />}
      {nonBilled.length > 0 && <GroupCard name="Non-billed" sub={nonBilled.map((r) => `Job ${r.job_number} ${r.site_name}`).join(', ')} badge={null} invoice={0} labor={summary.nonBilled.cost}
        lp={null} lpTone="" otCost={summary.nonBilled.otDollars} otPrior={prevSummary?.nonBilled.otDollars ?? null} otHours={summary.nonBilled.otHours} changeWord={changeWord} w={w} />}
    </div>
    {afterGroups}
    {(trend.length > 1 || !monthMode) && <ChartCard title={monthMode ? `${w.trendTitle} by month` : `${w.trendTitle}, last ${trendWeeks} weeks`} height={260}
      action={weeksSlider}
      legend={<><Swatch color={t.accent2} label={monthMode ? 'Month' : 'Week'} /><Swatch color={t.accent} label={monthMode ? 'Selected month' : 'Selected week'} /><Swatch line color={t.text2} label={invoiceLabel(w, vocab, period)} />
        <Swatch color={t.bad} label="Labor %" />{sitesLp && <Swatch color={t.warn} label="Sites-only labor %" />}
        {weekTargets ? <Swatch color={t.tgt} label={monthMode ? 'Monthly budget target' : 'Weekly budget target'} /> : <Swatch line color={t.ok} label={`Target ${pct(target)}`} />}
        {anyProjected && <Swatch line color={t.text3} label="Projected" />}</>}
      chart={trend.length ? <MonthWeekTrendChart labels={trend.map((x) => x.label)} labor={trend.map((x) => x.labor)} invoice={trend.map((x) => x.invoice)} lp={trend.map((x) => x.lp)} target={target} weekFrom={0}
        current={trendCurrent} weekTargets={weekTargets} sitesLp={sitesLp} unit={monthMode ? 'month' : 'week'} projected={projectedFlags}
        onPick={pickPoint} /> : <Skeleton height={240} />}
      table={<table><thead><tr><th className="nosort l">{monthMode ? 'Month' : 'Week ending'}</th><th className="nosort">{w.invoiceCol}</th><th className="nosort">{w.laborCol}</th><th className="nosort">Labor %</th>{sitesLp && <th className="nosort">Sites only</th>}{weekTargets && <th className="nosort">Budget target</th>}</tr></thead>
        <tbody>{trend.map((x, i) => <tr key={x.label}><td className="l">{x.label}{projectedFlags?.[i] ? ' (projected)' : ''}</td><td>{money(x.invoice)}</td><td>{money(x.labor)}</td><td>{pct(x.lp)}</td>{sitesLp && <td>{pct(sitesLp[i])}</td>}{weekTargets && <td>{pct(weekTargets[i])}</td>}</tr>)}</tbody></table>} />}
    {groups.length > 1 && <ChartCard title={`Labor % by ${segmentLabel(account).toLowerCase()}, ${monthMode ? 'by month' : `last ${trendWeeks} weeks`}`} height={280}
      action={weeksSlider}
      legend={<>{segSeries.map((s, i) => <Swatch key={s.name} color={t.series[i % t.series.length]} label={s.name} />)}
        {weekTargets ? <Swatch color={t.tgt} label="Budget target" />
          : segSeries.every((s) => s.target === segSeries[0].target) ? <Swatch line color={t.text2} label={`Target ${pct(segSeries[0].target)}`} />
            : <Swatch line color={t.text2} label="Group targets" />}
        {anyProjected && <Swatch line color={t.text3} label="Projected" />}</>}
      chart={trend.length ? <SegmentTrendChart labels={trend.map((x) => x.label)} series={segSeries} current={trendCurrent} budgetTargets={weekTargets} onPick={pickPoint} projected={projectedFlags} /> : <Skeleton height={260} />}
      table={<div className="tw"><table><thead><tr><th className="nosort l">{monthMode ? 'Month' : 'Week ending'}</th>{segSeries.map((s) => <th key={s.name} className="nosort">{s.name}</th>)}{weekTargets && <th className="nosort">Budget target</th>}</tr></thead>
        <tbody>{trend.map((x, i) => <tr key={x.key}><td className="l">{x.label}{projectedFlags?.[i] ? ' (projected)' : ''}</td>{segSeries.map((s) => <td key={s.name} className={toneOf(statusOf(s.values[i], s.target, options.watchBand))}>{pct(s.values[i])}</td>)}
          {weekTargets && <td>{pct(weekTargets[i])}</td>}</tr>)}</tbody></table></div>} />}
    {billed.length > 0 && <div className="charts2">
      <ChartCard title={`Labor % by ${subSites ? 'self-performed ' : ''}site this ${period}`} height={Math.max(200, sorted.length * 16 + 60)}
        legend={<><Swatch color={t.ok} label={vocab === 'fedex' ? 'On target' : 'On track'} /><Swatch color={t.warn} label="Watch" /><Swatch color={t.bad} label={vocab === 'fedex' ? 'Over' : 'High'} /><Swatch line label={`Target ${pct(target)}`} /></>}
        chart={<SiteLpChart labels={sorted.map((r) => short(r.site_name))} values={sorted.map((r) => r.measurePct)} tones={sorted.map((r) => toneOf(r.status))} target={target}
          details={sorted.map((r) => `${pct(r.measurePct)} (${money(r.cost)} / ${money(r.invoice)})`)} />}
        table={<table><thead><tr><th className="nosort l">Site</th><th className="nosort">Labor %</th><th className="nosort">{w.laborCol}</th><th className="nosort">{w.invoiceCol}</th></tr></thead>
          <tbody>{sorted.map((r) => <tr key={`${r.company}-${r.job_number}`}><td className="l">{r.site_name}</td><td>{pct(r.measurePct)}</td><td>{money(r.cost)}</td><td>{money(r.invoice)}</td></tr>)}</tbody></table>} />
      <ChartCard title={`${invoiceLabel(w, vocab, period)} vs labor by ${segmentLabel(account)}`} height={Math.max(180, mix.length * 44 + 40)}
        legend={<><Swatch color={t.accent2} label={invoiceLabel(w, vocab, period)} /><Swatch color={t.accent} label={`${w.direct} labor`} />{palD > 0 && <Swatch color={t.warn} label="Pallet labor" />}{a.vendor > 0 && <Swatch color={t.muted} label={subLabel} />}</>}
        chart={<LaborMixChart labels={mix.map((x) => x.name)} invoice={mix.map((x) => sum(x.list, (r) => r.invoice))} core={mix.map((x) => sum(x.list, directOf))}
          pallet={mix.map((x) => sum(x.list, palletOf))} sub={mix.map((x) => sum(x.list, (r) => r.vendor))} subLabel={subLabel} directLabel={`${w.direct} labor`} invoiceLabel={invoiceLabel(w, vocab, period)} />}
        table={<table><thead><tr><th className="nosort l">{segmentLabel(account)}</th><th className="nosort">{w.invoiceCol}</th><th className="nosort">{w.direct}</th><th className="nosort">Pallet</th><th className="nosort">{subLabel}</th></tr></thead>
          <tbody>{mix.map((x) => <tr key={x.name}><td className="l">{x.name}</td><td>{money(sum(x.list, (r) => r.invoice))}</td><td>{money(sum(x.list, directOf))}</td><td>{money(sum(x.list, palletOf))}</td><td>{money(sum(x.list, (r) => r.vendor))}</td></tr>)}</tbody></table>} />
    </div>}
    {can('data.qa') && <QaCards account={account} sites={sites} weekStart={period === 'week' ? weekStart ?? null : null} />}
    {footer}
  </>
}

/** OT cost against the prior period: "+12.4% WoW", tinted bad when it rose and ok when it fell. */
function otChange(cost: number, prior: number | null, word: string): ReactNode {
  if (prior == null) return null
  if (prior <= 0) return cost > 0 ? <span className="bad">new {word}</span> : null
  const change = cost / prior - 1
  return <span className={change > 0.005 ? 'bad' : change < -0.005 ? 'ok' : ''}>{`${change >= 0 ? '+' : '−'}${(Math.abs(change) * 100).toFixed(1)}% ${word}`}</span>
}

function GroupCard({ name, sub, badge, invoice, invoiceSub, labor, laborSub, lp, lpTone, lpSub, otCost, otPrior, otHours, changeWord, w }: {
  name: string; sub: string; badge: ReactNode; invoice: number; invoiceSub?: string; labor: number; laborSub?: string; lp: number | null; lpTone: string; lpSub?: string
  otCost: number; otPrior: number | null; otHours: number; changeWord: string; w: ReturnType<typeof wordsFor>
}) {
  const change = otChange(otCost, otPrior, changeWord)
  return <div className="card">
    <div className="seg-hdr"><div><div className="seg-name">{name}</div><div className="seg-sub">{sub}</div></div>{badge}</div>
    <div className="kpi4">
      <Kpi small label={w.labor} value={moneyK(labor)} sub={laborSub} />
      <Kpi small label={w.invoiceCol} value={moneyK(invoice)} sub={invoiceSub} />
      <Kpi small label="Labor %" value={pct(lp)} tone={lpTone} sub={lpSub} />
      <Kpi small label="OT cost" value={moneyK(otCost)} sub={<>{hours(otHours)} hrs{change && <>; {change}</>}</>} />
    </div>
  </div>
}
