import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ComposedChart, LabelList, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { QueryCard } from '../components/CardState'
import { CostDonut, CostMix, CostStack, costParts, hasCostBreakdown } from '../components/Charts'
import { ChartTooltip, LegendToggles, gridProps, monthTick, series, useSeriesToggle, xAxisProps, yAxisProps } from '../components/ChartKit'
import { DataGrid, type Column } from '../components/DataGrid'
import { KpiCard } from '../components/KpiCard'
import type { QueryState } from '../hooks/useApiQuery'
import type { ApSummary, LaborSummary, PortfolioSummary } from '../services/apiTypes'
import { money, moneyFull, percent, signed, sum, moneyTick, fmtDate } from '../utils'
import { DemoNotice, Note, rangeSubtitle, ScopeLine, useJobsQuery, useReportingParams, useReportQuery } from './shared'

type LaborGroup = { name: string; labor: number; budget: number | null; over: number | null }
type VendorRow = ApSummary['by_vendor'][number]

export function Expenses() {
  const { query, params } = useReportingParams()
  const labor = useReportQuery<LaborSummary>('labor/summary', (api, signal) => api.laborSummary(query, signal), params)
  const ap = useReportQuery<ApSummary>('ap/summary', (api, signal) => api.apSummary(query, signal), params)
  const summary = useReportQuery<PortfolioSummary>('portfolio/summary', (api, signal) => api.portfolioSummary(query, signal), params)
  const jobs = useJobsQuery()
  const [groupBy, setGroupBy] = useState<'branch' | 'account'>('branch')
  const toggle = useSeriesToggle()
  const k = labor.data?.kpis
  const pk = summary.data?.kpis
  // The finance reference source delivers the real direct-cost lines; the WinTeam API source only has labor + burden.
  const breakdown = hasCostBreakdown(pk) ? pk : null
  const burden = useMemo(() => sum(jobs.data?.jobs ?? [], (j) => j.burden_cost), [jobs.data])
  const groups = useMemo<LaborGroup[]>(() => {
    if (groupBy === 'account') return (labor.data?.by_account ?? []).map((a) => ({ name: a.parent_account, labor: a.labor_cost, budget: a.budget_labor, over: a.budget_labor ? ((a.labor_cost - a.budget_labor) / a.budget_labor) * 100 : null }))
    const map = new Map<string, LaborGroup & { hasBudget: boolean }>()
    for (const j of jobs.data?.jobs ?? []) {
      const entry = map.get(j.branch) ?? { name: j.branch, labor: 0, budget: 0, over: null, hasBudget: false }
      entry.labor += j.labor_cost
      if (j.budget_labor !== null) { entry.budget = (entry.budget ?? 0) + j.budget_labor; entry.hasBudget = true }
      map.set(j.branch, entry)
    }
    return [...map.values()].map((g) => ({ name: g.name, labor: g.labor, budget: g.hasBudget ? g.budget : null, over: g.hasBudget && g.budget ? ((g.labor - g.budget) / g.budget) * 100 : null }))
  }, [groupBy, labor.data, jobs.data]).sort((a, b) => b.labor - a.labor)
  const hasOpenBalance = (ap.data?.by_vendor ?? []).some((v) => typeof v.open_balance === 'number')
  const vendorColumns: Column<VendorRow>[] = [
    { key: 'vendor_name', header: 'Vendor', render: (r) => <><strong>{r.vendor_name}</strong><span className="muted"> {r.vendor_number}</span></> },
    { key: 'invoices', header: 'Invoices', numeric: true },
    { key: 'invoiced', header: 'Invoiced', numeric: true, render: (r) => moneyFull(r.invoiced) },
    { key: 'paid', header: 'Paid', numeric: true, render: (r) => moneyFull(r.paid) },
    ...(hasOpenBalance ? [
      { key: 'open_balance', header: 'Open balance', numeric: true, value: (r: VendorRow) => r.open_balance ?? null, render: (r: VendorRow) => moneyFull(r.open_balance) } as Column<VendorRow>,
      { key: 'past_due', header: 'Past due', numeric: true, value: (r: VendorRow) => r.past_due ?? null, className: (r: VendorRow) => ((r.past_due ?? 0) > 0 ? 'text-bad' : undefined), render: (r: VendorRow) => moneyFull(r.past_due) } as Column<VendorRow>,
    ] : [{ key: 'open', header: 'Unpaid', numeric: true, value: (r: VendorRow) => r.invoiced - r.paid, render: (r: VendorRow) => moneyFull(r.invoiced - r.paid) } as Column<VendorRow>]),
    { key: 'share', header: 'Share', numeric: true, value: (r) => (ap.data?.kpis.invoiced ? (r.invoiced / ap.data.kpis.invoiced) * 100 : null), render: (r) => percent(ap.data?.kpis.invoiced ? (r.invoiced / ap.data.kpis.invoiced) * 100 : null) },
  ]
  const apContext = ap.data ? `${money(ap.data.kpis.paid)} paid · ${ap.data.kpis.vendors} vendors${typeof ap.data.kpis.open_estimate === 'number' ? ` · ${money(ap.data.kpis.open_estimate)} open` : ''}` : ''
  return <>
    <ScopeLine />
    <DemoNotice>Direct-cost lines are split from seeded burden; vendor AP is a separate seeded ledger.</DemoNotice>
    <div className="kpi-grid kpi-grid--compact">
      {breakdown
        ? <KpiCard label="Direct cost" loading={summary.loading} value={money(breakdown.direct_cost)} delta={null} context={pk?.revenue ? `${percent((breakdown.direct_cost! / pk.revenue) * 100)} of revenue` : ''} trend={summary.data?.monthly.map((m) => m.direct_cost ?? 0)} favorable="down" />
        : <KpiCard label="Payroll burden" loading={jobs.loading} value={money(burden)} delta={null} context={k?.labor_cost ? `${percent((burden / k.labor_cost) * 100)} of labor` : ''} favorable="down" />}
      <KpiCard label="Labor cost" loading={labor.loading} value={money(k?.labor_cost)} delta={null} context={k?.budget_labor ? `${signed(k.labor_variance, (v) => money(v))} vs budget` : 'No labor budget in range'} trend={labor.data?.monthly.map((m) => m.labor_cost)} favorable="down" />
      {breakdown
        ? <KpiCard label="Payroll taxes & insurance" loading={summary.loading} value={money(breakdown.payroll_ti_cost)} delta={null} context={k?.labor_cost ? `${percent(((breakdown.payroll_ti_cost ?? 0) / k.labor_cost) * 100)} of labor` : ''} trend={summary.data?.monthly.map((m) => m.payroll_ti_cost ?? 0)} favorable="down" />
        : <KpiCard label="Overtime cost estimate" loading={labor.loading} value={money(k?.overtime_cost_estimate)} delta={null} context={`${percent(k?.overtime_pct)} of hours`} trend={labor.data?.monthly.map((m) => m.overtime_hours)} favorable="down" />}
      <KpiCard label="AP invoiced" loading={ap.loading} value={money(ap.data?.kpis.invoiced)} delta={null} context={apContext} trend={ap.data?.monthly.map((m) => m.invoiced)} favorable="down" />
    </div>
    {breakdown && <div className="dashboard-grid">
      <QueryCard title="Direct-cost mix" subtitle={`${rangeSubtitle(summary.data?.range)} · job-cost P&L lines`} className="span-5" query={summary} isEmpty={(s) => !(s.kpis.direct_cost ?? 0)} emptyHint="No direct cost in this range." note="Labor, payroll taxes & insurance, subcontractors, supplies & materials and other direct cost all reduce gross profit.">{() => <CostDonut row={breakdown} />}</QueryCard>
      <QueryCard title="Direct cost by month" subtitle="Trailing 12 months ending the anchor month · stacked by line" className="span-7" query={summary} isEmpty={(s) => !s.monthly.some((m) => (m.direct_cost ?? 0) > 0)}>{(s) => <CostStack data={s.monthly.map((m) => ({ month: m.month, labor_cost: m.labor_cost, payroll_ti_cost: m.payroll_ti_cost ?? 0, subcontract_cost: m.subcontract_cost ?? 0, supplies_cost: m.supplies_cost ?? 0, other_direct_cost: m.other_direct_cost ?? 0, direct_cost: m.direct_cost ?? 0 }))} />}</QueryCard>
    </div>}
    <div className="dashboard-grid">
      <QueryCard title="Labor vs budget" subtitle={`${rangeSubtitle(labor.data?.range)} · sorted by labor cost`} className="span-8" query={(groupBy === 'branch' ? jobs : labor) as QueryState<unknown>} isEmpty={() => !groups.length} action={<div className="segmented" role="group" aria-label="Group by"><button className={groupBy === 'branch' ? 'active' : ''} onClick={() => setGroupBy('branch')}>Branch</button><button className={groupBy === 'account' ? 'active' : ''} onClick={() => setGroupBy('account')}>Account</button></div>} note="Groups without a labor budget show actual only.">{() => <ResponsiveContainer width="100%" height="100%"><BarChart data={groups.slice(0, 12)} layout="vertical" margin={{ left: 4, right: 64, top: 4, bottom: 0 }} barGap={2}><CartesianGrid horizontal={false} stroke="var(--grid)" /><XAxis type="number" tickFormatter={moneyTick} {...xAxisProps} /><YAxis type="category" dataKey="name" width={124} tickLine={false} axisLine={false} tick={{ fill: 'var(--text)', fontSize: 11 }} /><Tooltip content={<ChartTooltip formatter={(v, n) => [money(Number(v)), n]} footer={(p) => { const row = p[0]?.payload as LaborGroup | undefined; return row?.over !== null && row?.over !== undefined ? <span className={row.over > 0 ? 'text-bad' : 'text-good'}>{signed(row.over, (x) => percent(x))} vs budget</span> : 'No budget' }} />} cursor={{ fill: 'var(--surface-2)' }} /><Bar dataKey="budget" name="Budget" fill={series.primarySoft} radius={[0, 4, 4, 0]} isAnimationActive={false} /><Bar dataKey="labor" name="Labor" fill={series.warn} radius={[0, 4, 4, 0]} isAnimationActive={false}><LabelList dataKey="over" position="right" formatter={(value: unknown) => (value === null || value === undefined ? '' : signed(Number(value), (x) => percent(x, 0)))} fill="var(--text)" fontSize={10} /></Bar></BarChart></ResponsiveContainer>}</QueryCard>
      {breakdown
        ? <QueryCard title="Direct cost vs revenue" subtitle={rangeSubtitle(summary.data?.range)} className="span-4" query={summary} isEmpty={(s) => !s.kpis.revenue}>{(s) => <table className="ratio-table"><tbody>{costParts(breakdown).map((p) => <tr key={p.key}><td><i style={{ background: p.color }} />{p.name}</td><td className="num">{money(p.value)}</td><td className="num muted">{percent((p.value / s.kpis.revenue) * 100)}</td></tr>)}<tr><td><strong>Direct cost</strong></td><td className="num"><strong>{money(breakdown.direct_cost)}</strong></td><td className="num"><strong>{percent((breakdown.direct_cost! / s.kpis.revenue) * 100)}</strong></td></tr><tr><td><strong>Gross profit</strong></td><td className="num"><strong>{money(s.kpis.gross_profit)}</strong></td><td className="num text-good"><strong>{percent(s.kpis.gross_margin_pct)}</strong></td></tr></tbody></table>}</QueryCard>
        : <QueryCard title="Cost mix" subtitle={rangeSubtitle(labor.data?.range)} className="span-4" query={labor} isEmpty={(l) => !l.kpis.labor_cost}>{(l) => <CostMix parts={[{ name: 'Labor', value: l.kpis.labor_cost, color: series.navy }, { name: 'Payroll burden', value: burden, color: series.primary }, { name: 'Overtime premium (in labor)', value: l.kpis.overtime_cost_estimate, color: series.warn, note: 'Estimate; already inside labor' }, { name: 'Vendor AP', value: ap.data?.kpis.invoiced ?? 0, color: series.secondary, note: 'Supplies & subcontract invoices' }]} />}</QueryCard>}
    </div>
    <div className="dashboard-grid">
      <QueryCard title="AP invoiced vs paid" subtitle={`${rangeSubtitle(ap.data?.range)} · by month${ap.data?.kpis.paid_through ? ` · payment history through ${fmtDate(ap.data.kpis.paid_through)}` : ''}`} className="span-7" query={ap} isEmpty={(a) => !a.monthly.length}>{(a) => <div className="chart-with-legend"><LegendToggles series={[{ key: 'invoiced', name: 'Invoiced', color: series.secondary, kind: 'bar' }, { key: 'paid', name: 'Paid', color: series.good }]} hidden={toggle.hidden} onToggle={toggle.toggle} /><ResponsiveContainer width="100%" height="100%"><ComposedChart data={a.monthly} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid {...gridProps} /><XAxis dataKey="month" tickFormatter={monthTick} {...xAxisProps} /><YAxis tickFormatter={moneyTick} {...yAxisProps} /><Tooltip content={<ChartTooltip formatter={(v, n) => [money(Number(v)), n]} />} cursor={{ fill: 'var(--surface-2)' }} /><Bar dataKey="invoiced" name="Invoiced" fill={series.secondary} fillOpacity={0.55} radius={[4, 4, 0, 0]} hide={toggle.isHidden('invoiced')} isAnimationActive={false} /><Line dataKey="paid" name="Paid" stroke={series.good} strokeWidth={2.5} dot={false} hide={toggle.isHidden('paid')} isAnimationActive={false} /></ComposedChart></ResponsiveContainer></div>}</QueryCard>
      <QueryCard title="Due in the next 30 days" subtitle="Unpaid AP by due week" className="span-5" query={ap} isEmpty={(a) => !a.due_next_30_days.length} emptyHint="No unpaid vendor invoices due soon.">{(a) => <div className="due-list">{a.due_next_30_days.map((d) => { const max = Math.max(...a.due_next_30_days.map((x) => x.amount), 1); return <div key={d.due_week_start} className="due-row"><span>Week of {d.due_week_start.slice(5)}</span><i><em style={{ width: `${(d.amount / max) * 100}%` }} /></i><b className="num">{money(d.amount)}</b><small className="num">{d.invoices} inv.</small></div> })}</div>}</QueryCard>
    </div>
    <QueryCard title="AP by vendor" subtitle={rangeSubtitle(ap.data?.range)} query={ap} skeleton="table" isEmpty={(a) => !a.by_vendor.length} note={hasOpenBalance ? <Note>Open balance and past due come from the latest vendor aging snapshot{ap.data?.source.ar_as_of ? ` (as of ${ap.data.source.ar_as_of})` : ''}; invoiced and paid cover the selected range.</Note> : undefined}>{(a) => <DataGrid rows={a.by_vendor} columns={vendorColumns} rowKey={(r) => r.vendor_number} defaultSort={{ key: 'invoiced', dir: 'desc' }} csvName="ap-by-vendor" dense />}</QueryCard>
  </>
}
