/**
 * The FedEx Labor P&L report's views (vocabulary 'fedex'): Account Overview, Sites, Pallet, Income
 * Statement and Subcontracted Sites. Sites carry their pallet job rolled in (data.ts prepareRows);
 * subcontracted sites are left out of the labor views and scored on AR − AP instead.
 */
import { useMemo, useState, type ReactNode } from 'react'
import type { LeadershipAccount, LeadershipMonthlyJob, LeadershipRow } from '../../services/apiTypes'
import { LaborMixChart, MarginChart, MonthWeekTrendChart, SiteLpChart, useTokens } from '../charts'
import { closedMonths, dataFlags, monthLaborPct, monthRevenue, PALLET_GROUPS, rowsOfWeek, segmentOrder, siteMonths, useMonthly, useRows, vendorLabel } from '../data'
import { hours, hours1, money, moneyK, pct } from '../format'
import { accountSummary, statusOf, type AccountSummary, type MetricOptions, type SiteMetrics } from '../metrics'
import { Notes } from '../Overview'
import { monthLabel, monthShort, weekTick } from '../routes'
import { useLeadership } from '../state'
import { Badge, ChartCard, Empty, Kpi, LoadError, Pills, Skeleton, SortTable, Swatch, toneOf, type Column } from '../ui'
import { weekChange } from '../vocab'

type Row = SiteMetrics<LeadershipRow>
type Summary = AccountSummary<LeadershipRow>

const pallet = (r: Row) => r.pallet_labor ?? 0
const core = (r: Row) => r.labor - pallet(r)
const variableWk = (r: Row, o: MetricOptions) => {
  const monthly = o.invoiceBasis === 'run_rate_3m' ? r.variable_run_rate : r.revenue_month_variable
  return monthly == null ? null : monthly / (o.divisor ?? 4.33)
}
const lpCell = (v: number | null, target: number) => <span className={toneOf(statusOf(v, target))}>{pct(v)}</span>
const short = (name: string) => name.replace(/^FedEx - /, '').replace(', CA 94534', '').replace(' - Cargo Bldg', ' Cargo')

function useSiteOpener() {
  const { navigate } = useLeadership()
  return (r: LeadershipRow) => navigate({ site: { company: r.company ?? '', job: r.job_number } })
}

function basisNote(account: LeadershipAccount, options: MetricOptions, revenueMonth: string | null, fixed: number, variable: number | null) {
  const div = account.revenue_divisor
  if (options.invoiceBasis === 'run_rate_3m') return variable != null ? `Fixed ${moneyK(fixed)} + variable ${moneyK(variable)} run rate ÷ ${div}` : `3-month run rate ÷ ${div}`
  return `${monthLabel(revenueMonth)} revenue ÷ ${div}`
}

// Account Overview
export function FedexOverview({ account, rows, summary, options }: { account: LeadershipAccount; rows: LeadershipRow[]; summary: Summary; options: MetricOptions }) {
  const { config, weekStart } = useLeadership()
  const t = useTokens()
  const target = options.target
  const history = useRows(account.slug, 8)
  const monthly = useMonthly(account.slug)
  const flags = useMemo(() => dataFlags(config.data, weekStart, rows), [config.data, weekStart, rows])
  const revenueMonth = rows.find((r) => r.revenue_month)?.revenue_month ?? null
  const all = summary.all
  const sites = summary.sites
  const billed = sites.filter((r) => r.invoice > 0)
  const unbilled = sites.filter((r) => !(r.invoice > 0) && r.labor > 0)
  const palD = sites.reduce((a, r) => a + pallet(r), 0)
  const palHrs = sites.reduce((a, r) => a + (r.pallet_hours ?? 0), 0)
  const variable = sites.every((r) => variableWk(r, options) == null) ? null : sites.reduce((a, r) => a + (variableWk(r, options) ?? 0), 0)
  const unbilledHours = unbilled.reduce((a, r) => a + r.hours + r.otPremiumHours, 0)
  const hot = summary.billed.overHours + unbilledHours

  // Prior week and the trend: the same rows shaped the same way, week by week.
  const weeks = useMemo(() => {
    const list = history.data?.weeks ?? []
    return list.map((w) => { const wr = rowsOfWeek(history.data?.rows, w); return { week: w, s: wr.length ? accountSummary(wr, options, segmentOrder(account)).all : null } })
  }, [history.data, options, account])
  const prev = weeks.length > 1 ? weeks[weeks.length - 2].s : null
  const lastMonth = closedMonths(monthly.data).at(-1)
  const augLp = useMemo(() => (monthly.data && lastMonth ? monthLaborPct(selfPerformJobs(monthly.data.jobs), lastMonth, options.vendorFactor ?? 1) : null), [monthly.data, lastMonth, options.vendorFactor])
  const delta = (cur: number | null, before: number | null | undefined, format: (v: number) => string) =>
    cur == null || before == null ? '' : `; ${cur - before >= 0 ? '+' : '−'}${format(Math.abs(cur - before))} vs prior wk`

  const groups = PALLET_GROUPS.map((g) => ({ g, list: sites.filter((r) => r.segment === g) })).filter((x) => x.list.length)
  const sorted = [...billed].sort((a, b) => (b.measurePct ?? 0) - (a.measurePct ?? 0))
  const trend = useMemo(() => {
    const out: { label: string; labor: number | null; invoice: number | null; lp: number | null }[] = []
    const div = account.revenue_divisor
    if (monthly.data) for (const m of closedMonths(monthly.data)) {
      const jobs = selfPerformJobs(monthly.data.jobs)
      const inv = jobs.reduce((a, j) => a + monthRevenue(j.months[m]), 0)
      const lab = jobs.reduce((a, j) => a + (j.months[m]?.direct_labor ?? 0) + (j.months[m]?.subcontractors ?? 0) * (options.vendorFactor ?? 1), 0)
      out.push({ label: `${monthShort(m)} actual`, labor: lab / div, invoice: inv / div, lp: inv > 0 ? lab / inv : null })
    }
    for (const w of weeks) out.push({ label: weekTick(w.week), labor: w.s?.cost ?? null, invoice: w.s?.invoice ?? null, lp: w.s?.measurePct ?? null })
    return out
  }, [monthly.data, weeks, account, options.vendorFactor])
  const weekFrom = trend.length - weeks.length

  return <>
    <div className="kpi-lg">
      <Kpi label="Weekly invoice" value={money(all.invoice)} sub={basisNote(account, options, revenueMonth, all.invoice - (variable ?? 0), variable)} />
      <Kpi label="Labor" value={money(all.cost)} sub={`Core ${moneyK(all.labor - palD)} + pallet ${moneyK(palD)}${all.vendor ? ` + sub ~${moneyK(all.vendor)}` : ''}${delta(all.cost, prev?.cost, money)}`} />
      <Kpi label="Account labor %" value={pct(all.measurePct)} tone={toneOf(statusOf(all.measurePct, target, options.watchBand))}
        sub={`Target ${pct(target)}; ${monthLabel(lastMonth ?? null)} actual ${pct(augLp)}${prev?.measurePct != null && all.measurePct != null ? `; ${weekChange(all.measurePct - prev.measurePct, 'fedex')}` : ''}`} />
      <Kpi label="Hours paid" value={hours(all.hours)} sub={`${hours(all.otHours)} OT/DT (${pct(all.otPct)}); pallet ${hours(palHrs)}${delta(all.hours, prev?.hours, hours)}`} />
      <Kpi label="Hours over target" value={hours(hot)} tone={hot > 0 ? 'bad' : 'ok'}
        sub={`${summary.billed.over} of ${billed.length} billed sites over${unbilled.length ? `, plus ${hours(unbilledHours)} unbilled` : ''}`} />
    </div>
    <Notes summary={summary} account={account} flags={flags} options={options} revenueMonth={revenueMonth} />
    <div className="seg-grid">
      {groups.map(({ g, list }) => {
        const s = accountSummary(list, options, []).all
        const palG = list.reduce((a, r) => a + pallet(r), 0)
        const varG = list.every((r) => variableWk(r, options) == null) ? null : list.reduce((a, r) => a + (variableWk(r, options) ?? 0), 0)
        const lp = monthly.data && lastMonth ? monthLaborPct(monthly.data.jobs.filter((j) => list.some((r) => r.company === j.company && (r.kids ?? [r.job_number]).includes(j.job_number))), lastMonth, options.vendorFactor ?? 1) : null
        const status = statusOf(s.measurePct, target, options.watchBand)
        return <div className="card" key={g}>
          <div className="seg-hdr"><div><div className="seg-name">{g}</div><div className="seg-sub">{list.length} sites, {s.over} over target</div></div><Badge status={status} /></div>
          <div className="kpi4">
            <Kpi small label="Invoice" value={moneyK(s.invoice)} sub={g === PALLET_GROUPS[0] && varG != null ? `${moneyK(varG)} variable` : undefined} />
            <Kpi small label="Labor" value={moneyK(s.cost)} sub={g === PALLET_GROUPS[0] ? `${moneyK(palG)} pallet` : undefined} />
            <Kpi small label="Labor %" value={pct(s.measurePct)} tone={toneOf(status)} sub={lastMonth ? `${monthShort(lastMonth)} ${pct(lp)}` : undefined} />
            <Kpi small label="OT %" value={pct(s.otPct)} sub={`${hours(s.otHours)} hrs`} tone={s.otPct > 0.15 ? 'bad' : s.otPct > 0.1 ? 'warn' : ''} />
          </div>
        </div>
      })}
    </div>
    {trend.length > 1 && <ChartCard title="Labor vs invoice: monthly actuals (weekly equivalent) and weekly timekeeping" height={260}
      legend={<><Swatch color={t.muted} label="Monthly actual" /><Swatch color={t.accent2} label="Week" /><Swatch color={t.bad} label="Labor %" /><Swatch line label={`Target ${pct(target)}`} /></>}
      chart={<MonthWeekTrendChart labels={trend.map((x) => x.label)} labor={trend.map((x) => x.labor)} invoice={trend.map((x) => x.invoice)} lp={trend.map((x) => x.lp)} target={target} weekFrom={weekFrom} current={trend.length - 1} />}
      table={<table><thead><tr><th className="nosort l">Period</th><th className="nosort">Invoice</th><th className="nosort">Labor</th><th className="nosort">Labor %</th></tr></thead>
        <tbody>{trend.map((x) => <tr key={x.label}><td className="l">{x.label}</td><td>{money(x.invoice)}</td><td>{money(x.labor)}</td><td>{pct(x.lp)}</td></tr>)}</tbody></table>} />}
    <div className="charts2">
      <ChartCard title="Labor % by site this week" height={Math.max(200, sorted.length * 16 + 60)}
        legend={<><Swatch color={t.ok} label="On target" /><Swatch color={t.warn} label="Watch" /><Swatch color={t.bad} label="Over" /><Swatch line label={`Target ${pct(target)}`} /></>}
        chart={<SiteLpChart labels={sorted.map((r) => short(r.site_name))} values={sorted.map((r) => r.measurePct)} tones={sorted.map((r) => toneOf(r.status))} target={target}
          details={sorted.map((r) => `${pct(r.measurePct)} (${money(r.cost)} / ${money(r.invoice)})`)} />}
        table={<table><thead><tr><th className="nosort l">Site</th><th className="nosort">Labor %</th><th className="nosort">Labor</th><th className="nosort">Invoice</th></tr></thead>
          <tbody>{sorted.map((r) => <tr key={r.job_number}><td className="l">{r.site_name}</td><td>{pct(r.measurePct)}</td><td>{money(r.cost)}</td><td>{money(r.invoice)}</td></tr>)}</tbody></table>} />
      <ChartCard title="Where the labor dollars went" height={200}
        legend={<><Swatch color={t.accent2} label="Weekly invoice" /><Swatch color={t.accent} label="Core labor" /><Swatch color={t.warn} label="Pallet labor" /><Swatch color={t.muted} label="Sub ~est." /></>}
        chart={<LaborMixChart labels={groups.map((x) => x.g)} invoice={groups.map((x) => x.list.reduce((a, r) => a + r.invoice, 0))} core={groups.map((x) => x.list.reduce((a, r) => a + core(r), 0))}
          pallet={groups.map((x) => x.list.reduce((a, r) => a + pallet(r), 0))} sub={groups.map((x) => x.list.reduce((a, r) => a + r.vendor, 0))} subLabel="Sub ~est." />}
        table={<table><thead><tr><th className="nosort l">Group</th><th className="nosort">Invoice</th><th className="nosort">Core</th><th className="nosort">Pallet</th><th className="nosort">Sub</th></tr></thead>
          <tbody>{groups.map((x) => <tr key={x.g}><td className="l">{x.g}</td><td>{money(x.list.reduce((a, r) => a + r.invoice, 0))}</td><td>{money(x.list.reduce((a, r) => a + core(r), 0))}</td><td>{money(x.list.reduce((a, r) => a + pallet(r), 0))}</td><td>{money(x.list.reduce((a, r) => a + r.vendor, 0))}</td></tr>)}</tbody></table>} />
    </div>
  </>
}

/** Monthly jobs on the labor views: not subcontracted, pallet jobs included (they sum into their site). */
const selfPerformJobs = (jobs: LeadershipMonthlyJob[]) => jobs.filter((j) => j.delivery_model !== 'subcontracted' && (j.role === 'site' || j.role === 'pallet'))

// Sites
export function FedexSites({ account, summary, options }: { account: LeadershipAccount; summary: Summary; options: MetricOptions }) {
  const [filter, setFilter] = useState('All')
  const open = useSiteOpener()
  const monthly = useMonthly(account.slug)
  const months = closedMonths(monthly.data)
  const [julKey, augKey] = [months.at(-2), months.at(-1)]
  const factor = options.vendorFactor ?? 1
  const lpOf = (r: Row, m: string | undefined) => (m && monthly.data ? monthLaborPct(siteMonths(monthly.data.jobs, r.company, r.kids, r.job_number), m, factor) : null)
  const rows = summary.sites.filter((r) => filter === 'All' || r.segment === filter)
  const cols: Column<Row>[] = [
    { key: 'job', header: 'Job', left: true, value: (r) => Number(r.job_number) || r.job_number, render: (r) => <>{r.job_number}{(r.kids?.length ?? 1) > 1 && <span className="neutral"> +{r.kids!.slice(1).join(',')}</span>}</> },
    { key: 'name', header: 'Site', left: true, value: (r) => r.site_name, className: 'nm', render: (r) => <>{r.site_name}{r.labor_basis !== 'pay_report' && r.labor > 0 && <span className="warn"> ~</span>}</> },
    { key: 'fix', header: 'Fixed inv', value: (r) => r.invoice - (variableWk(r, options) ?? 0), render: (r) => money(r.invoice - (variableWk(r, options) ?? 0)) },
    { key: 'var', header: 'Var inv', value: (r) => variableWk(r, options), render: (r) => (variableWk(r, options) ? money(variableWk(r, options)) : '–') },
    { key: 'inv', header: 'Invoice', value: (r) => r.invoice, render: (r) => money(r.invoice) },
    { key: 'core', header: 'Core $', value: core, render: (r) => money(core(r)) },
    { key: 'pal', header: 'Pallet $', value: pallet, render: (r) => (pallet(r) ? money(pallet(r)) : '–') },
    { key: 'sub', header: 'Sub ~$', value: (r) => r.vendor, render: (r) => (r.vendor ? <span className="warn">~{money(r.vendor)}</span> : '–') },
    { key: 'lab', header: 'Labor $', value: (r) => r.cost, render: (r) => <b>{money(r.cost)}</b> },
    { key: 'lp', header: 'Labor %', value: (r) => r.measurePct, render: (r) => <span className={toneOf(r.status)}>{pct(r.measurePct)}</span> },
    ...[julKey, augKey].filter((m): m is string => Boolean(m)).map((m): Column<Row> => ({ key: `lp-${m}`, header: `${monthShort(m)} LP`, value: (r) => lpOf(r, m), render: (r) => <span className="neutral">{pct(lpOf(r, m))}</span> })),
    { key: 'hrs', header: 'Hours', value: (r) => r.hours, render: (r) => hours1(r.hours) },
    { key: 'oth', header: 'OT hrs', value: (r) => r.ot_hours, render: (r) => hours1(r.ot_hours) },
    { key: 'otp', header: 'OT %', value: (r) => r.otPct, render: (r) => <span className={r.otPct > 0.25 ? 'bad' : r.otPct > 0.15 ? 'warn' : ''}>{pct(r.otPct)}</span> },
    { key: 'over', header: 'Hrs over', value: (r) => r.overHours, render: (r) => (r.overHours > 0.5 ? <span className="bad">{hours1(r.overHours)}</span> : '–') },
    { key: 'st', header: 'Status', value: (r) => r.measurePct, render: (r) => <Badge status={r.status} />, csv: (r) => r.status },
  ]
  const s = accountSummary(rows, options, []).all
  const sum = (f: (r: Row) => number | null) => rows.reduce((a, r) => a + (f(r) ?? 0), 0)
  const tot = <tr className="tot"><td></td><td className="l">Total ({rows.length})</td><td>{money(sum((r) => r.invoice - (variableWk(r, options) ?? 0)))}</td><td>{money(sum((r) => variableWk(r, options)))}</td>
    <td>{money(s.invoice)}</td><td>{money(sum(core))}</td><td>{money(sum(pallet))}</td><td className="warn">{s.vendor ? `~${money(s.vendor)}` : '–'}</td><td>{money(s.cost)}</td>
    <td className={toneOf(statusOf(s.measurePct, options.target, options.watchBand))}>{pct(s.measurePct)}</td>{[julKey, augKey].filter(Boolean).map((m) => <td key={m} />)}<td>{hours1(s.hours)}</td><td>{hours1(s.otHours)}</td><td>{pct(s.otPct)}</td><td>{hours1(sum((r) => r.overHours))}</td><td></td></tr>
  return <>
    <Pills label="Filter sites" options={['All', ...PALLET_GROUPS].map((o) => ({ value: o, label: o }))} value={filter} onChange={setFilter} />
    <div className="card"><SortTable caption={`${account.name} sites`} rows={rows} columns={cols} defaultSort={{ key: 'lp', dir: -1 }} total={tot}
      rowClass={(r) => (r.invoice > 0 ? '' : 'dim')} onRowClick={open} rowLabel={(r) => `Open ${r.site_name}`} csvName={`${account.slug}-sites`} /></div>
  </>
}

// Pallet
export function PalletTab({ account, summary, options }: { account: LeadershipAccount; summary: Summary; options: MetricOptions }) {
  const monthly = useMonthly(account.slug)
  const lastMonth = closedMonths(monthly.data).at(-1)
  const target = options.target
  const sites = summary.sites.filter((r) => (r.kids?.length ?? 1) > 1)
  if (!sites.length) return <Empty>No pallet sites this week.</Empty>
  const s = accountSummary(sites, options, []).all
  const palD = sites.reduce((a, r) => a + pallet(r), 0)
  const palHrs = sites.reduce((a, r) => a + (r.pallet_hours ?? 0), 0)
  const palOt = sites.reduce((a, r) => a + (r.pallet_ot_hours ?? 0), 0)
  const hasVariable = sites.some((r) => variableWk(r, options) != null)
  const varWk = sites.reduce((a, r) => a + (variableWk(r, options) ?? 0), 0)
  // The last closed month: pallet job direct labor ÷ the site's variable revenue.
  const monthPallet = (r: Row) => {
    if (!monthly.data || !lastMonth) return { labor: 0, variable: null as number | null }
    const jobs = siteMonths(monthly.data.jobs, r.company, r.kids, r.job_number)
    const labor = jobs.filter((j) => j.role === 'pallet').reduce((a, j) => a + (j.months[lastMonth]?.direct_labor ?? 0), 0)
    const vs = jobs.map((j) => j.months[lastMonth]?.revenue_variable).filter((v): v is number => v != null)
    return { labor, variable: vs.length ? vs.reduce((a, v) => a + v, 0) : null }
  }
  const monthTotals = sites.map(monthPallet).reduce((a, m) => ({ labor: a.labor + m.labor, variable: m.variable == null ? a.variable : (a.variable ?? 0) + m.variable }), { labor: 0, variable: null as number | null })
  const palLp = (r: Row) => { const v = variableWk(r, options); return v ? pallet(r) / v : null }
  const coreLp = (r: Row) => { const fixed = r.invoice - (variableWk(r, options) ?? 0); return fixed > 0 ? (core(r) + r.vendor) / fixed : null }
  const cols: Column<Row>[] = [
    { key: 'job', header: 'Jobs', left: true, value: (r) => Number(r.job_number) || r.job_number, render: (r) => (r.kids ?? [r.job_number]).join(' + ') },
    { key: 'name', header: 'Site', left: true, value: (r) => r.site_name, className: 'nm' },
    { key: 'fix', header: 'Fixed inv', value: (r) => r.invoice - (variableWk(r, options) ?? 0), render: (r) => money(r.invoice - (variableWk(r, options) ?? 0)) },
    { key: 'core', header: 'Core $', value: (r) => core(r) + r.vendor, render: (r) => money(core(r) + r.vendor) },
    { key: 'clp', header: 'Core LP', value: coreLp, render: (r) => lpCell(coreLp(r), target) },
    { key: 'var', header: 'Var inv', value: (r) => variableWk(r, options), render: (r) => money(variableWk(r, options)) },
    { key: 'pal', header: 'Pallet $', value: pallet, render: (r) => money(pallet(r)) },
    { key: 'plp', header: 'Pallet LP', value: palLp, render: (r) => lpCell(palLp(r), target) },
    { key: 'paug', header: `${monthShort(lastMonth ?? null)} pallet LP`, value: (r) => { const m = monthPallet(r); return m.variable ? m.labor / m.variable : null }, render: (r) => { const m = monthPallet(r); return <span className="neutral">{pct(m.variable ? m.labor / m.variable : null)}</span> } },
    { key: 'ph', header: 'Pallet hrs', value: (r) => r.pallet_hours ?? 0, render: (r) => hours1(r.pallet_hours ?? 0) },
    { key: 'pot', header: 'Pallet OT %', value: (r) => (r.pallet_hours ? (r.pallet_ot_hours ?? 0) / r.pallet_hours : 0), render: (r) => { const v = r.pallet_hours ? (r.pallet_ot_hours ?? 0) / r.pallet_hours : 0; return <span className={v > 0.25 ? 'bad' : v > 0.15 ? 'warn' : ''}>{pct(v)}</span> } },
    { key: 'lp', header: 'Combined LP', value: (r) => r.measurePct, render: (r) => <b>{lpCell(r.measurePct, target)}</b> },
  ]
  return <>
    <div className="kpi-lg">
      <Kpi label="Pallet labor" value={money(palD)} sub={`${pct(s.labor ? palD / s.labor : null)} of labor at pallet sites`} />
      <Kpi label="Variable invoice" value={hasVariable ? money(varWk) : '–'} sub={hasVariable ? (options.invoiceBasis === 'run_rate_3m' ? `OS revenue run rate ÷ ${account.revenue_divisor}` : `${monthLabel(lastMonth ?? null)} OS revenue ÷ ${account.revenue_divisor}`) : 'Job Cost Analysis revenue split not loaded'} />
      <Kpi label="Pallet labor % of variable" value={hasVariable ? pct(varWk ? palD / varWk : null) : '–'} tone={hasVariable ? toneOf(statusOf(varWk ? palD / varWk : null, target, options.watchBand)) : ''}
        sub={monthTotals.variable ? `${monthLabel(lastMonth ?? null)} actual ${pct(monthTotals.labor / monthTotals.variable)}` : undefined} />
      <Kpi label="Pallet hours" value={hours(palHrs)} sub={`${hours(palOt)} OT/DT (${pct(palHrs ? palOt / palHrs : null)})`} tone={palHrs && palOt / palHrs > 0.15 ? 'bad' : palHrs && palOt / palHrs > 0.1 ? 'warn' : ''} />
      <Kpi label="Pallet sites combined LP" value={pct(s.measurePct)} tone={toneOf(statusOf(s.measurePct, target, options.watchBand))} sub="Core + pallet + sub ÷ fixed + variable" />
    </div>
    <div className="card"><SortTable caption="Pallet sites" rows={sites} columns={cols} defaultSort={{ key: 'lp', dir: -1 }} csvName={`${account.slug}-pallet`} /></div>
  </>
}

// Subcontracted Sites
interface SubSite { company: string; job_number: string; name: string; ar: number; ap: number; direct: number; margin: number; marginPct: number | null }
const subTone = (r: SubSite) => (r.marginPct == null && r.ap + r.direct === 0 ? 'neutral' : r.margin < 0 ? 'bad' : (r.marginPct ?? 0) < 0.05 ? 'warn' : 'ok')
const SUB_STATUS = { bad: 'Upside down', warn: 'Thin', ok: 'OK', neutral: '–' } as const

export function SubcontractedTab({ account }: { account: LeadershipAccount }) {
  const monthly = useMonthly(account.slug)
  const [scope, setScope] = useState('all')
  const t = useTokens()
  const data = monthly.data
  const months = data?.months ?? []
  const rows: SubSite[] = useMemo(() => {
    if (!data) return []
    const picked = scope === 'all' ? data.months : [scope]
    return data.jobs.filter((j) => j.delivery_model === 'subcontracted' && j.role === 'site').map((j) => {
      let ar = 0, ap = 0, direct = 0
      for (const m of picked) { const x = j.months[m]; ar += monthRevenue(x); ap += x ? (x.relay_ap > 0 ? x.relay_ap : x.subcontractors) : 0; direct += x?.direct_labor ?? 0 }
      const margin = ar - ap - direct
      return { company: j.company, job_number: j.job_number, name: (j.job_name ?? '').replace(/^FedEx - /, '') || j.job_number, ar, ap, direct, margin, marginPct: ar > 0 ? margin / ar : null }
    }).filter((r) => r.ar > 0 || r.ap + r.direct > 0)
  }, [data, scope])
  if (monthly.error) return <LoadError error={monthly.error} onRetry={monthly.refetch} />
  if (!data) return <Skeleton height={400} />
  if (!rows.length) return <Empty>No subcontracted sites with billing or cost in these months.</Empty>
  const T = rows.reduce((a, r) => ({ ar: a.ar + r.ar, ap: a.ap + r.ap, direct: a.direct + r.direct }), { ar: 0, ap: 0, direct: 0 })
  const margin = T.ar - T.ap - T.direct
  const upside = rows.filter((r) => r.margin < 0)
  const thin = rows.filter((r) => r.margin >= 0 && (r.marginPct ?? 0) < 0.05)
  const noAr = rows.filter((r) => r.ar === 0)
  const worst = [...rows].sort((a, b) => a.margin - b.margin).slice(0, 25)
  const scopeLabel = scope === 'all' ? `${months.length} months` : monthLabel(scope)
  const cols: Column<SubSite>[] = [
    { key: 'job', header: 'Job', left: true, value: (r) => Number(r.job_number) || r.job_number },
    { key: 'name', header: 'Site', left: true, value: (r) => r.name, className: 'nm' },
    { key: 'ar', header: 'AR', value: (r) => r.ar, render: (r) => money(r.ar) },
    { key: 'ap', header: 'AP', value: (r) => r.ap, render: (r) => money(r.ap) },
    { key: 'dir', header: 'Direct $', value: (r) => r.direct, render: (r) => (r.direct ? money(r.direct) : '–') },
    { key: 'mg', header: 'Margin $', value: (r) => r.margin, render: (r) => <b className={subTone(r)}>{money(r.margin)}</b> },
    { key: 'mp', header: 'Margin %', value: (r) => r.marginPct, render: (r) => <span className={subTone(r)}>{r.ar === 0 ? 'No AR' : pct(r.marginPct)}</span> },
    { key: 'st', header: 'Status', value: (r) => r.margin, render: (r) => { const c = subTone(r); return <span className={`badge ${{ bad: 'bbad', warn: 'bwarn', ok: 'bok', neutral: 'bnone' }[c]}`}>{SUB_STATUS[c]}</span> }, csv: (r) => SUB_STATUS[subTone(r)] },
  ]
  const tot = <tr className="tot"><td></td><td className="l">Total ({rows.length})</td><td>{money(T.ar)}</td><td>{money(T.ap)}</td><td>{T.direct ? money(T.direct) : '–'}</td><td>{money(margin)}</td><td>{pct(T.ar ? margin / T.ar : null)}</td><td></td></tr>
  return <>
    <Pills label="Months" options={[...months.map((m) => ({ value: m, label: monthLabel(m) })), { value: 'all', label: `${months.length} months` }]} value={scope} onChange={setScope} />
    <div className="kpi-lg">
      <Kpi label="Sites" value={rows.length} sub={scopeLabel} />
      <Kpi label="AR" value={money(T.ar)} sub="Relay AR, else job cost revenue" />
      <Kpi label={`AP (${vendorLabel(account).toLowerCase()} cost)`} value={money(T.ap)} sub={T.direct ? `Plus ${money(T.direct)} direct labor` : undefined} />
      <Kpi label="Margin" value={money(margin)} sub={pct(T.ar ? margin / T.ar : null)} tone={margin < 0 ? 'bad' : T.ar && margin / T.ar < 0.05 ? 'warn' : 'ok'} />
      <Kpi label="Upside down" value={upside.length} tone={upside.length ? 'bad' : 'ok'} sub={`${money(upside.reduce((a, r) => a + r.margin, 0))}; ${thin.length} more under 5%`} />
    </div>
    {noAr.length > 0 && <dl className="notes"><div><dt className="bad">AP with no AR on record</dt><dd>{noAr.slice(0, 12).map((r) => `${r.job_number} ${r.name} (${money(r.ap + r.direct)})`).join(', ')}{noAr.length > 12 ? `, ${noAr.length - 12} more` : ''}</dd></div></dl>}
    <ChartCard title="Margin by site, worst first (AR − AP)" height={Math.max(160, worst.length * 18 + 60)}
      legend={<><Swatch color={t.bad} label="Upside down" /><Swatch color={t.warn} label="Thin, under 5%" /><Swatch color={t.ok} label="OK" /></>}
      chart={<MarginChart labels={worst.map((r) => `${r.job_number} ${r.name}`)} values={worst.map((r) => r.margin)} tones={worst.map(subTone)}
        details={worst.map((r) => `AR ${money(r.ar)}, AP ${money(r.ap)}${r.direct ? `, direct ${money(r.direct)}` : ''}: ${money(r.margin)} (${r.ar ? pct(r.marginPct) : 'no AR'})`)} />}
      table={<table><thead><tr><th className="nosort l">Site</th><th className="nosort">AR</th><th className="nosort">AP</th><th className="nosort">Margin</th></tr></thead>
        <tbody>{worst.map((r) => <tr key={`${r.company}-${r.job_number}`}><td className="l">{r.job_number} {r.name}</td><td>{money(r.ar)}</td><td>{money(r.ap)}</td><td>{money(r.margin)}</td></tr>)}</tbody></table>} />
    <div className="card"><SortTable caption="Subcontracted sites" rows={rows} columns={cols} defaultSort={{ key: 'mg', dir: 1 }} total={tot} csvName={`${account.slug}-subcontracted`} pageSize={50} /></div>
  </>
}

// Income Statement
export function IncomeStatementTab({ account, options }: { account: LeadershipAccount; options: MetricOptions }) {
  const monthly = useMonthly(account.slug)
  if (monthly.error) return <LoadError error={monthly.error} onRetry={monthly.refetch} />
  if (!monthly.data) return <Skeleton height={400} />
  const { months, jobs, income_statement: IS } = monthly.data
  const loaded = months.filter((m) => IS[m] && IS[m].revenue != null)
  if (!loaded.length) return <Empty>No Trend Income Statement loaded for {months.length ? `${monthLabel(months[0])} to ${monthLabel(months.at(-1)!)}` : 'these months'}. Import it in Admin, Imports.</Empty>
  const factor = options.vendorFactor ?? 1
  const onDashboard = new Set(selfPerformJobs(jobs).map((j) => `${j.company}|${j.job_number}`))
  const C = Object.fromEntries(loaded.map((m) => {
    const I = IS[m]
    const sum = (inside: boolean, f: (x: LeadershipMonthlyJob['months'][string]) => number) => jobs.filter((j) => onDashboard.has(`${j.company}|${j.job_number}`) === inside).reduce((a, j) => a + (j.months[m] ? f(j.months[m]) : 0), 0)
    const inRev = sum(true, (x) => x.revenue), inDir = sum(true, (x) => x.direct_labor), inSub = sum(true, (x) => x.subcontractors)
    const exJobRev = sum(false, (x) => x.revenue), exDir = sum(false, (x) => x.direct_labor), exSub = sum(false, (x) => x.subcontractors)
    const wages = I.wages ?? inDir + exDir, tax = I.payroll_taxes ?? 0, taxRate = wages ? tax / wages : 0
    const revSubGL = I.revenue_subcontracted_gl ?? 0
    const subNoJob = (I.subcontractors ?? inSub + exSub) - inSub - exSub
    const other = (I.supplies ?? 0) + (I.vehicle ?? 0) + (I.travel ?? 0) + (I.insurance ?? 0)
    const inTax = inDir * taxRate, exTax = exDir * taxRate
    const exRev = exJobRev + revSubGL
    const inCost = inDir + inTax + inSub, exCost = exDir + exTax + exSub + subNoJob
    return [m, { I, inRev, inDir, inSub, exJobRev, exDir, exSub, revSubGL, subNoJob, other, taxRate, exRev, inCost, exCost, inC: inRev - inCost, exC: exRev - exCost,
      inLpU: inRev ? (inDir + inSub * factor) / inRev : null, inLpL: inRev ? inCost / inRev : null, gpCalc: inRev - inCost + exRev - exCost - other }]
  }))
  const A = C[loaded.at(-1)!]
  const L = (m: string) => monthShort(m)
  const pc = (v: number | null) => <span className="neutral"> {pct(v)}</span>
  const row = (label: string, f: (x: (typeof C)[string]) => ReactNode, cls = '', indent = false) =>
    <tr className={cls}><td className="l" style={indent ? { paddingLeft: 22 } : undefined}>{label}</td>{loaded.map((m) => <td key={m}>{f(C[m])}</td>)}</tr>
  const head = (label: string) => <tr><td className="l"><b>{label}</b></td>{loaded.map((m) => <td key={m}></td>)}</tr>
  return <>
    <div className="kpi-lg">
      <Kpi label={`${monthLabel(loaded.at(-1)!)} revenue (IS)`} value={money(A.I.revenue)} sub={`Dashboard sites ${pct(A.I.revenue ? A.inRev / A.I.revenue : null)} of it`} />
      <Kpi label="Dashboard sites, labor %" value={pct(A.inLpU)} tone={toneOf(statusOf(A.inLpU, options.target, options.watchBand))} sub="Unloaded, same basis as the dashboard" />
      <Kpi label="Dashboard sites, loaded" value={pct(A.inLpL)} tone={toneOf(statusOf(A.inLpL, options.target, options.watchBand))} sub={`Adds payroll taxes at ${pct(A.taxRate)} of wages`} />
      <Kpi label="Subcontracted book" value={pct(A.exRev ? A.exC / A.exRev : null)} sub={`Margin on ${moneyK(A.exRev)} revenue`} tone={A.exRev && A.exC / A.exRev < 0.15 ? 'warn' : ''} />
      <Kpi label="Gross profit (IS)" value={money(A.I.gross_profit)} sub={`${pct(A.I.revenue && A.I.gross_profit != null ? A.I.gross_profit / A.I.revenue : null)} of revenue`} />
    </div>
    <div className="card"><div className="ct"><span>Bridge: income statement to dashboard sites</span></div>
      <div className="tw"><table><caption className="sr-only">Income statement bridge</caption>
        <thead><tr><th className="nosort l"></th>{loaded.map((m) => <th key={m} className="nosort">{L(m)}</th>)}</tr></thead>
        <tbody>
          {head('Revenue')}
          {row('Dashboard sites', (x) => money(x.inRev), '', true)}
          {row('Excluded sites, on their jobs', (x) => money(x.exJobRev), '', true)}
          {row('Subcontracted revenue, GL only (no job)', (x) => (x.revSubGL ? money(x.revSubGL) : '–'), '', true)}
          {row('Income statement revenue', (x) => money(x.I.revenue), 'tot')}
          {head('Direct wages')}
          {row('Dashboard sites', (x) => money(x.inDir), '', true)}
          {row('Excluded sites', (x) => money(x.exDir), '', true)}
          {row('Income statement wages', (x) => money(x.I.wages), 'tot')}
          {row('Payroll taxes (IS), % of wages', (x) => <>{money(x.I.payroll_taxes)}{pc(x.taxRate)}</>)}
          {head('Subcontractor cost')}
          {row('Dashboard sites', (x) => money(x.inSub), '', true)}
          {row('Excluded sites', (x) => money(x.exSub), '', true)}
          {row('GL only (no job)', (x) => (Math.abs(x.subNoJob) > 1 ? money(x.subNoJob) : '–'), '', true)}
          {row('Income statement sub cost', (x) => money(x.I.subcontractors), 'tot')}
          {head('Margin by book (after wages, taxes pro rata, sub)')}
          {row('Dashboard sites', (x) => <>{money(x.inC)}{pc(x.inRev ? x.inC / x.inRev : null)}</>, '', true)}
          {row('Subcontracted / excluded book', (x) => <>{money(x.exC)}{pc(x.exRev ? x.exC / x.exRev : null)}</>, '', true)}
          {row('Supplies, vehicle, travel, insurance (IS)', (x) => money(-x.other), '', true)}
          {row('Gross profit', (x) => <>{money(x.gpCalc)}{pc(x.I.revenue ? x.gpCalc / x.I.revenue : null)}</>, 'tot')}
          {row('Income statement gross profit', (x) => <span className="neutral">{money(x.I.gross_profit)}</span>)}
          {head('Dashboard sites labor %')}
          {row(`Unloaded: wages + sub at ${Math.round(factor * 100)}% (dashboard basis)`, (x) => lpCell(x.inLpU, options.target), '', true)}
          {row('Loaded: wages + payroll taxes + sub at 100%', (x) => lpCell(x.inLpL, options.target), '', true)}
        </tbody>
      </table></div></div>
  </>
}
