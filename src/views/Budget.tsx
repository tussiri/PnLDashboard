import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { QueryCard } from '../components/CardState'
import { ChartTooltip, LegendToggles, gridProps, monthTick, series, useSeriesToggle, xAxisProps, yAxisProps } from '../components/ChartKit'
import { DataGrid, type Column } from '../components/DataGrid'
import { useDashboard } from '../context/DashboardContext'
import type { BudgetVariance } from '../services/apiTypes'
import { money, moneyFull, percent, signed, moneyTick } from '../utils'
import { DemoNotice, Note, rangeSubtitle, ScopeLine, useReportingParams, useReportQuery } from './shared'

type AccountLine = BudgetVariance['by_account'][number]
type JobLine = BudgetVariance['by_job'][number]

export function Budget() {
  const { query, params } = useReportingParams()
  const { openJob } = useDashboard()
  const budget = useReportQuery<BudgetVariance>('budget/variance', (api, signal) => api.budgetVariance(query, signal), params)
  const toggle = useSeriesToggle()
  const lines = budget.data?.lines ?? []
  const chartLines = lines.filter((l) => l.actual !== null && l.budget !== null)
  const vendorActuals = lines.some((l) => (l.name === 'Subcontract' || l.name === 'Supplies') && l.actual !== null)
  const accountColumns: Column<AccountLine>[] = [
    { key: 'parent_account', header: 'Account', render: (r) => <strong>{r.parent_account}</strong> },
    { key: 'revenue', header: 'Revenue', numeric: true, render: (r) => moneyFull(r.revenue) },
    { key: 'budget_revenue', header: 'Rev. budget', numeric: true, render: (r) => moneyFull(r.budget_revenue) },
    { key: 'rev_var', header: 'Rev. variance', numeric: true, value: (r) => (r.budget_revenue === null ? null : r.revenue - r.budget_revenue), className: (r) => (r.budget_revenue === null ? undefined : r.revenue >= r.budget_revenue ? 'text-good' : 'text-bad'), render: (r) => (r.budget_revenue === null ? '—' : signed(r.revenue - r.budget_revenue, (v) => money(v))) },
    { key: 'labor_cost', header: 'Labor', numeric: true, render: (r) => moneyFull(r.labor_cost) },
    { key: 'budget_labor', header: 'Labor budget', numeric: true, render: (r) => moneyFull(r.budget_labor) },
    { key: 'labor_var', header: 'Labor variance', numeric: true, value: (r) => (r.budget_labor ? ((r.labor_cost - r.budget_labor) / r.budget_labor) * 100 : null), className: (r) => (r.budget_labor === null ? undefined : r.labor_cost <= r.budget_labor ? 'text-good' : 'text-bad'), render: (r) => (r.budget_labor ? `${signed(r.labor_cost - r.budget_labor, (v) => money(v))} · ${signed(((r.labor_cost - r.budget_labor) / r.budget_labor) * 100, (v) => percent(v))}` : '—') },
  ]
  const jobColumns: Column<JobLine>[] = [
    { key: 'job_name', header: 'Site', render: (r) => <><strong>{r.job_name}</strong><span className="muted"> {r.job_number}</span></> },
    { key: 'revenue', header: 'Revenue', numeric: true, render: (r) => money(r.revenue) },
    { key: 'budget_revenue', header: 'Rev. budget', numeric: true, render: (r) => money(r.budget_revenue) },
    { key: 'labor_cost', header: 'Labor', numeric: true, render: (r) => money(r.labor_cost) },
    { key: 'budget_labor', header: 'Labor budget', numeric: true, render: (r) => money(r.budget_labor) },
    { key: 'labor_variance_pct', header: 'Labor var. %', numeric: true, className: (r) => (r.labor_variance_pct === null ? undefined : r.labor_variance_pct > 7 ? 'text-bad' : r.labor_variance_pct > 0 ? 'text-warn' : 'text-good'), render: (r) => (r.labor_variance_pct === null ? <span className="muted">no budget</span> : signed(r.labor_variance_pct, (v) => percent(v))) },
  ]
  return <>
    <ScopeLine />
    <DemoNotice>Seeded budgets cover most sites; subcontract and supplies lines carry budgets only.</DemoNotice>
    <QueryCard title="Variance summary" subtitle={rangeSubtitle(budget.data?.range)} query={budget} skeleton="kpi" isEmpty={(b) => !b.lines.length} note={vendorActuals ? <Note>Subcontract and supplies actuals come from the job-cost P&L (finance reference source); on the WinTeam API source these lines carry budgets only.</Note> : undefined}>{(b) => <div className="variance-strip">{b.lines.map((l) => <div key={l.name} className={l.actual === null ? 'is-muted' : ''}><span>{l.name}</span><strong className="num">{l.actual === null ? (l.budget === null ? '—' : `${money(l.budget)} budget`) : money(l.actual)}</strong><small className={`num ${l.favorable === null ? 'muted' : l.favorable ? 'text-good' : 'text-bad'}`}>{l.variance === null ? (l.actual === null ? 'No actuals in marts' : 'No budget') : `${signed(l.variance, (v) => money(v))} · ${signed(l.variance_pct, (v) => percent(v))}`}</small></div>)}</div>}</QueryCard>
    <div className="dashboard-grid">
      <QueryCard title="Actual vs budget" subtitle={`${rangeSubtitle(budget.data?.range)} · lines with both values`} className="span-6" query={budget} isEmpty={() => !chartLines.length} emptyHint="No budget rows for these filters.">{() => <ResponsiveContainer width="100%" height="100%"><BarChart data={chartLines} margin={{ top: 18, right: 8, left: 0, bottom: 0 }} barGap={3}><CartesianGrid {...gridProps} /><XAxis dataKey="name" {...xAxisProps} /><YAxis tickFormatter={moneyTick} {...yAxisProps} /><Tooltip content={<ChartTooltip formatter={(v, n) => [money(Number(v)), n]} />} cursor={{ fill: 'var(--surface-2)' }} /><Bar dataKey="budget" name="Budget" fill={series.primarySoft} radius={[4, 4, 0, 0]} isAnimationActive={false} /><Bar dataKey="actual" name="Actual" radius={[4, 4, 0, 0]} isAnimationActive={false}>{chartLines.map((l) => <Cell key={l.name} fill={l.favorable ? series.good : series.warn} />)}<LabelList dataKey="variance_pct" position="top" formatter={(value: unknown) => (value === null || value === undefined ? '' : signed(Number(value), (x) => percent(x)))} fill="var(--text)" fontSize={10} /></Bar></BarChart></ResponsiveContainer>}</QueryCard>
      <QueryCard title="Monthly pacing" subtitle="Trailing 12 months · revenue and labor vs budget" className="span-6" query={budget} isEmpty={(b) => !b.monthly.length}>{(b) => <div className="chart-with-legend"><LegendToggles series={[{ key: 'budget_revenue', name: 'Revenue budget', color: series.primarySoft, kind: 'bar' }, { key: 'revenue', name: 'Revenue', color: series.primary }, { key: 'budget_labor', name: 'Labor budget', color: series.mutedText, kind: 'dash' }, { key: 'labor_cost', name: 'Labor', color: series.warn }]} hidden={toggle.hidden} onToggle={toggle.toggle} /><ResponsiveContainer width="100%" height="100%"><ComposedChart data={b.monthly} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid {...gridProps} /><XAxis dataKey="month" tickFormatter={monthTick} {...xAxisProps} /><YAxis tickFormatter={moneyTick} {...yAxisProps} /><Tooltip content={<ChartTooltip formatter={(v, n) => [money(Number(v)), n]} />} cursor={{ fill: 'var(--surface-2)' }} /><Bar dataKey="budget_revenue" name="Revenue budget" fill={series.primarySoft} radius={[3, 3, 0, 0]} hide={toggle.isHidden('budget_revenue')} isAnimationActive={false} /><Line dataKey="revenue" name="Revenue" stroke={series.primary} strokeWidth={2.5} dot={false} hide={toggle.isHidden('revenue')} isAnimationActive={false} /><Line dataKey="budget_labor" name="Labor budget" stroke={series.mutedText} strokeDasharray="4 4" strokeWidth={1.5} dot={false} hide={toggle.isHidden('budget_labor')} isAnimationActive={false} /><Line dataKey="labor_cost" name="Labor" stroke={series.warn} strokeWidth={2} dot={false} hide={toggle.isHidden('labor_cost')} isAnimationActive={false} /></ComposedChart></ResponsiveContainer></div>}</QueryCard>
    </div>
    <QueryCard title="By account" subtitle={rangeSubtitle(budget.data?.range)} query={budget} skeleton="table" isEmpty={(b) => !b.by_account.length}>{(b) => <DataGrid rows={b.by_account} columns={accountColumns} rowKey={(r) => r.parent_account} defaultSort={{ key: 'labor_var', dir: 'desc' }} csvName="budget-by-account" dense />}</QueryCard>
    <QueryCard title="By site" subtitle={rangeSubtitle(budget.data?.range)} query={budget} skeleton="table" isEmpty={(b) => !b.by_job.length} note={budget.data ? <Note>Budget coverage: {budget.data.coverage.jobs_with_budget} of {budget.data.coverage.jobs_total} sites carry a labor budget for this range. Sites without one are listed with actuals only and never counted in variance totals.</Note> : null}>{(b) => <DataGrid rows={b.by_job} columns={jobColumns} rowKey={(r) => r.job_number} defaultSort={{ key: 'labor_variance_pct', dir: 'desc' }} onRowClick={(r) => openJob(r.job_number)} csvName="budget-by-site" pageSize={15} dense />}</QueryCard>
  </>
}
