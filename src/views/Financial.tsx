import { useMemo } from 'react'
import { QueryCard } from '../components/CardState'
import { CostDonut, CostMix, PerformanceTrend, hasCostBreakdown } from '../components/Charts'
import { series } from '../components/ChartKit'
import { DataGrid, type Column } from '../components/DataGrid'
import { KpiCard } from '../components/KpiCard'
import { useDashboard } from '../context/DashboardContext'
import type { JobRow, PortfolioMonth, PortfolioSummary } from '../services/apiTypes'
import { monthLabel } from '../services/period'
import { money, moneyFull, percent, signed, sum } from '../utils'
import { DemoNotice, rangeSubtitle, ScopeCoverageLine, ScopeLine, useJobsQuery, useReportingParams, useReportQuery } from './shared'

interface PlLine { name: string; actual: number | null; budget: number | null; pctOfRevenue: number | null; favorableWhenOver: boolean; sub?: boolean }

export function Financial() {
  const { query, params } = useReportingParams()
  const { openJob } = useDashboard()
  const summary = useReportQuery<PortfolioSummary>('portfolio/summary', (api, signal) => api.portfolioSummary(query, signal), params)
  const jobs = useJobsQuery()
  const k = summary.data?.kpis, d = summary.data?.deltas
  const burden = useMemo(() => sum(jobs.data?.jobs ?? [], (j) => j.burden_cost), [jobs.data])
  const breakdown = hasCostBreakdown(k) ? k : null
  const lines = useMemo<PlLine[]>(() => {
    if (!k) return []
    const rev = k.revenue || null
    const pctOf = (v: number | null) => (v !== null && rev ? (v / rev) * 100 : null)
    if (breakdown) {
      const direct = breakdown.direct_cost ?? 0
      const cost = (name: string, value: number | undefined, sub = true): PlLine => ({ name, actual: value ?? 0, budget: null, pctOfRevenue: pctOf(value ?? 0), favorableWhenOver: false, sub })
      return [
        { name: 'Revenue', actual: k.revenue, budget: k.budget_revenue, pctOfRevenue: 100, favorableWhenOver: true },
        { name: 'Labor cost', actual: k.labor_cost, budget: k.budget_labor, pctOfRevenue: pctOf(k.labor_cost), favorableWhenOver: false, sub: true },
        cost('Payroll taxes & insurance', breakdown.payroll_ti_cost), cost('Subcontractors', breakdown.subcontract_cost), cost('Supplies & materials', breakdown.supplies_cost), cost('Other direct cost', breakdown.other_direct_cost),
        { name: 'Direct cost', actual: direct, budget: null, pctOfRevenue: pctOf(direct), favorableWhenOver: false },
        { name: 'Gross profit', actual: k.gross_profit, budget: k.budget_revenue !== null && k.budget_labor !== null ? k.budget_revenue - k.budget_labor - (direct - k.labor_cost) : null, pctOfRevenue: k.gross_margin_pct, favorableWhenOver: true },
      ]
    }
    return [
      { name: 'Revenue', actual: k.revenue, budget: k.budget_revenue, pctOfRevenue: 100, favorableWhenOver: true },
      { name: 'Labor cost', actual: k.labor_cost, budget: k.budget_labor, pctOfRevenue: pctOf(k.labor_cost), favorableWhenOver: false },
      { name: 'Payroll burden', actual: jobs.data ? burden : null, budget: null, pctOfRevenue: jobs.data ? pctOf(burden) : null, favorableWhenOver: false },
      { name: 'Direct cost', actual: jobs.data ? k.labor_cost + burden : null, budget: null, pctOfRevenue: jobs.data ? pctOf(k.labor_cost + burden) : null, favorableWhenOver: false },
      { name: 'Gross profit', actual: k.gross_profit, budget: k.budget_revenue !== null && k.budget_labor !== null ? k.budget_revenue - k.budget_labor - burden : null, pctOfRevenue: k.gross_margin_pct, favorableWhenOver: true },
    ]
  }, [k, burden, jobs.data, breakdown])
  const plColumns: Column<PlLine>[] = [
    { key: 'name', header: 'Line', sortable: false, render: (r) => (r.sub ? <span className="muted">{r.name}</span> : <strong>{r.name}</strong>) },
    { key: 'actual', header: 'Actual', numeric: true, sortable: false, render: (r) => moneyFull(r.actual) },
    { key: 'pctOfRevenue', header: '% of revenue', numeric: true, sortable: false, render: (r) => percent(r.pctOfRevenue) },
    { key: 'budget', header: 'Budget', numeric: true, sortable: false, render: (r) => (r.budget === null ? <span className="muted">—</span> : moneyFull(r.budget)) },
    { key: 'variance', header: 'Variance', numeric: true, sortable: false, value: (r) => (r.actual !== null && r.budget !== null ? r.actual - r.budget : null), className: (r) => (r.actual === null || r.budget === null ? undefined : (r.favorableWhenOver ? r.actual >= r.budget : r.actual <= r.budget) ? 'text-good' : 'text-bad'), render: (r) => (r.actual !== null && r.budget !== null ? `${signed(r.actual - r.budget, (v) => moneyFull(v))} · ${signed(r.budget ? ((r.actual - r.budget) / r.budget) * 100 : null, (v) => percent(v))}` : '—') },
  ]
  const monthColumns: Column<PortfolioMonth>[] = [
    { key: 'month', header: 'Month', render: (r) => monthLabel(r.month), csv: (r) => r.month },
    { key: 'revenue', header: 'Revenue', numeric: true, render: (r) => moneyFull(r.revenue) },
    { key: 'budget_revenue', header: 'Budget', numeric: true, render: (r) => moneyFull(r.budget_revenue) },
    { key: 'labor_cost', header: 'Labor', numeric: true, render: (r) => moneyFull(r.labor_cost) },
    { key: 'gross_profit', header: 'Gross profit', numeric: true, render: (r) => moneyFull(r.gross_profit) },
    { key: 'margin', header: 'Margin', numeric: true, value: (r) => (r.revenue ? (r.gross_profit / r.revenue) * 100 : null), render: (r) => percent(r.revenue ? (r.gross_profit / r.revenue) * 100 : null) },
    { key: 'hours', header: 'Hours', numeric: true, render: (r) => r.hours.toLocaleString() },
    { key: 'jobs_reporting', header: 'Sites', numeric: true },
  ]
  const top = useMemo(() => [...(jobs.data?.jobs ?? [])].sort((a, b) => b.revenue - a.revenue).slice(0, 8), [jobs.data])
  return <>
    <ScopeLine range={summary.data?.range} />
    <ScopeCoverageLine range={summary.data?.range} share={summary.data?.kpis.revenue_share_of_all} />
    <DemoNotice>P&amp;L lines are aggregated from seeded site-month rows.</DemoNotice>
    <div className="kpi-grid kpi-grid--compact">
      <KpiCard label="Revenue" loading={summary.loading} value={money(k?.revenue)} delta={d?.revenue_pct} context={rangeSubtitle(summary.data?.range, 'vs prior range')} trend={summary.data?.monthly.map((m) => m.revenue)} />
      <KpiCard label="Gross margin" loading={summary.loading} value={percent(k?.gross_margin_pct)} delta={d?.gross_margin_pts} deltaUnit="pts" context={`${money(k?.gross_profit)} gross profit`} trend={summary.data?.monthly.map((m) => (m.revenue ? (m.gross_profit / m.revenue) * 100 : 0))} />
      <KpiCard label="Labor % of revenue" loading={summary.loading} value={percent(k?.labor_pct_revenue)} delta={d?.labor_pct_pts} deltaUnit="pts" context={k?.budget_labor ? `${signed(((k.labor_cost - k.budget_labor) / k.budget_labor) * 100, (v) => percent(v))} vs labor budget` : 'No labor budget in range'} trend={summary.data?.monthly.map((m) => (m.revenue ? (m.labor_cost / m.revenue) * 100 : 0))} favorable="down" />
      <KpiCard label="Revenue vs budget" loading={summary.loading} value={k?.budget_revenue ? signed(((k.revenue - k.budget_revenue) / k.budget_revenue) * 100, (v) => percent(v)) : '—'} delta={null} context={k?.budget_revenue ? `${money(k.budget_revenue)} budget` : 'No revenue budget in range'} trend={summary.data?.monthly.map((m) => m.budget_revenue ?? 0)} />
    </div>
    <div className="dashboard-grid">
      <QueryCard title="P&L summary" subtitle={rangeSubtitle(summary.data?.range)} className="span-7" query={summary} skeleton="table" isEmpty={(s) => !s.kpis.revenue} emptyHint="No revenue in this range for the current filters." note={breakdown ? 'Gross profit = revenue − direct cost (labor, payroll taxes & insurance, subcontractors, supplies & materials, other direct) from the job-cost P&L. Budget gross profit is derived client-side as budget revenue − budget labor − actual non-labor direct cost.' : 'Gross profit = revenue − labor − payroll burden. Budget gross profit is derived client-side as budget revenue − budget labor − actual burden.'}>{() => <DataGrid rows={lines} columns={plColumns} rowKey={(r) => r.name} csvName="financial-summary" dense />}</QueryCard>
      {breakdown
        ? <QueryCard title="Direct cost mix" subtitle={`${rangeSubtitle(summary.data?.range)} · job-cost P&L lines`} className="span-5" query={summary} isEmpty={(s) => !(s.kpis.direct_cost ?? 0)}>{() => <CostDonut row={breakdown} />}</QueryCard>
        : <QueryCard title="Direct cost mix" subtitle={rangeSubtitle(summary.data?.range)} className="span-5" query={jobs} isEmpty={(j) => !j.jobs.length}>{(j) => <CostMix parts={[{ name: 'Labor', value: sum(j.jobs, (r: JobRow) => r.labor_cost), color: series.navy }, { name: 'Payroll burden', value: sum(j.jobs, (r: JobRow) => r.burden_cost), color: series.primary }, { name: 'AP invoiced (vendors)', value: k?.ap_invoiced ?? 0, color: series.secondary, note: 'Not part of gross profit' }]} />}</QueryCard>}
    </div>
    <div className="dashboard-grid">
      <QueryCard title="Financial performance trend" subtitle="Trailing 12 months ending the anchor month · USD" className="span-8" query={summary} isEmpty={(s) => !s.monthly.length}>{(s) => <PerformanceTrend data={s.monthly} />}</QueryCard>
      <QueryCard title="Highest-revenue sites" subtitle={rangeSubtitle(jobs.data?.range)} className="span-4" query={jobs} isEmpty={() => !top.length}>{() => <div className="rank-list">{top.map((job, i) => <button key={job.job_number} onClick={() => openJob(job.job_number)}><span>{i + 1}</span><div><strong>{job.job_name}</strong><i style={{ width: `${(job.revenue / (top[0]?.revenue || 1)) * 100}%` }} /></div><b className="num">{money(job.revenue)}</b></button>)}</div>}</QueryCard>
    </div>
    <QueryCard title="Monthly detail" subtitle="Trailing 12 months · sortable" query={summary} skeleton="table" isEmpty={(s) => !s.monthly.length}>{(s) => <DataGrid rows={s.monthly} columns={monthColumns} rowKey={(r) => r.month} csvName="financial-monthly" dense />}</QueryCard>
  </>
}
