/**
 * Views from the FedEx Labor P&L report, shown for any account with the data: Pallet (accounts with
 * pallet jobs), Income Statement (a loaded Trend Income Statement) and Subcontracted Sites (AR − AP
 * margin per subcontracted site).
 */
import { useMemo, useState, type ReactNode } from 'react'
import type { LeadershipAccount, LeadershipMonthlyJob, LeadershipRow } from '../../services/apiTypes'
import { MarginChart, useTokens } from '../charts'
import { closedMonths, monthRevenue, siteMonths, useMonthly, vendorLabel } from '../data'
import { hours, hours1, money, moneyK, pct } from '../format'
import { accountSummary, statusOf, type AccountSummary, type MetricOptions, type SiteMetrics } from '../metrics'
import { directOf, laborJobs, palletOf, variableWk } from '../Overview'
import { monthLabel, monthShort } from '../routes'
import { ChartCard, Empty, Kpi, LoadError, Pills, Skeleton, SortTable, Swatch, toneOf, type Column } from '../ui'

type Row = SiteMetrics<LeadershipRow>
type Summary = AccountSummary<LeadershipRow>

const pallet = palletOf
const core = directOf
const lpCell = (v: number | null, target: number) => <span className={toneOf(statusOf(v, target))}>{pct(v)}</span>

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
      for (const m of picked) { const x = j.months[m]; ar += monthRevenue(x, true); ap += x ? (x.relay_ap > 0 ? x.relay_ap : x.subcontractors) : 0; direct += x?.direct_labor ?? 0 }
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
  const onDashboard = new Set(laborJobs(account, jobs).filter((j) => j.delivery_model !== 'subcontracted').map((j) => `${j.company}|${j.job_number}`))
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
