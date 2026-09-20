import { useMemo } from 'react'
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { QueryCard } from '../components/CardState'
import { GroupBars, PerformanceTrend } from '../components/Charts'
import { ChartTooltip, LegendToggles, gridProps, monthTick, series, useSeriesToggle, xAxisProps, yAxisProps } from '../components/ChartKit'
import { DataGrid, type Column } from '../components/DataGrid'
import { KpiCard } from '../components/KpiCard'
import { useDashboard } from '../context/DashboardContext'
import type { AccountTotals, PortfolioSummary } from '../services/apiTypes'
import { money, moneyFull, percent, sum, moneyTick } from '../utils'
import { DemoNotice, rangeSubtitle, ScopeLine, useReportingParams, useReportQuery } from './shared'

export function Revenue() {
  const { query, params } = useReportingParams()
  const { setFilters, navigate } = useDashboard()
  const summary = useReportQuery<PortfolioSummary>('portfolio/summary', (api, signal) => api.portfolioSummary(query, signal), params)
  const k = summary.data?.kpis, d = summary.data?.deltas
  const accounts = useMemo(() => [...(summary.data?.by_account ?? [])].sort((a, b) => b.revenue - a.revenue), [summary.data])
  const revenue = k?.revenue ?? 0
  const top3 = revenue ? (sum(accounts.slice(0, 3), (a) => a.revenue) / revenue) * 100 : null
  const sites = k?.active_jobs ?? 0
  const toggle = useSeriesToggle()
  const columns: Column<AccountTotals>[] = [
    { key: 'name', header: 'Account', render: (r) => <strong>{r.name}</strong> },
    { key: 'jobs', header: 'Sites', numeric: true },
    { key: 'revenue', header: 'Revenue', numeric: true, render: (r) => moneyFull(r.revenue) },
    { key: 'share', header: 'Share', numeric: true, value: (r) => (revenue ? (r.revenue / revenue) * 100 : null), render: (r) => percent(revenue ? (r.revenue / revenue) * 100 : null) },
    { key: 'gross_profit', header: 'Gross profit', numeric: true, render: (r) => moneyFull(r.gross_profit) },
    { key: 'margin', header: 'Margin', numeric: true, value: (r) => (r.revenue ? (r.gross_profit / r.revenue) * 100 : null), render: (r) => percent(r.revenue ? (r.gross_profit / r.revenue) * 100 : null) },
    { key: 'per_site', header: 'Revenue / site', numeric: true, value: (r) => (r.jobs ? r.revenue / r.jobs : null), render: (r) => money(r.jobs ? r.revenue / r.jobs : null) },
  ]
  const filterToAccount = (name: string) => { setFilters((f) => ({ ...f, account: name })); navigate('jobs') }
  return <>
    <ScopeLine />
    <DemoNotice>Seeded revenue by service month; invoiced and collected are separate demo series.</DemoNotice>
    <div className="kpi-grid kpi-grid--compact">
      <KpiCard label="Revenue" loading={summary.loading} value={money(revenue)} delta={d?.revenue_pct} context={rangeSubtitle(summary.data?.range, 'vs prior range')} trend={summary.data?.monthly.map((m) => m.revenue)} />
      <KpiCard label="Largest account" loading={summary.loading} value={money(accounts[0]?.revenue)} delta={null} context={accounts[0]?.name ?? '—'} trend={summary.data?.monthly.map((m) => m.revenue)} favorable="none" />
      <KpiCard label="Top-3 concentration" loading={summary.loading} value={percent(top3)} delta={null} context={`${Math.min(3, accounts.length)} of ${accounts.length} accounts`} favorable="down" />
      <KpiCard label="Revenue per site" loading={summary.loading} value={money(sites ? revenue / sites : null)} delta={null} context={`${sites} active sites`} favorable="none" />
    </div>
    <div className="dashboard-grid">
      <QueryCard title="Revenue vs budget" subtitle="Trailing 12 months ending the anchor month · USD" className="span-8" query={summary} isEmpty={(s) => !s.monthly.length}>{(s) => <PerformanceTrend data={s.monthly} showGrossProfit={false} />}</QueryCard>
      <QueryCard title="Revenue by account" subtitle={`${rangeSubtitle(summary.data?.range)} · click to filter sites`} className="span-4" query={summary} isEmpty={(s) => !s.by_account.length}>{() => <GroupBars data={accounts} onSelect={filterToAccount} max={12} />}</QueryCard>
    </div>
    <div className="dashboard-grid">
      <QueryCard title="Invoiced vs collected" subtitle="Trailing 12 months · billing activity, not recognized revenue" className="span-7" query={summary} isEmpty={(s) => !s.monthly.some((m) => m.invoiced_total || m.collected_total)} emptyHint="No invoice or payment activity in the marts for these months.">{(s) => <div className="chart-with-legend"><LegendToggles series={[{ key: 'invoiced_total', name: 'Invoiced', color: series.primary, kind: 'bar' }, { key: 'collected_total', name: 'Collected', color: series.good }, { key: 'revenue', name: 'Revenue', color: series.mutedText, kind: 'dash' }]} hidden={toggle.hidden} onToggle={toggle.toggle} /><ResponsiveContainer width="100%" height="100%"><ComposedChart data={s.monthly} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid {...gridProps} /><XAxis dataKey="month" tickFormatter={monthTick} {...xAxisProps} /><YAxis tickFormatter={moneyTick} {...yAxisProps} /><Tooltip content={<ChartTooltip formatter={(v, n) => [money(Number(v)), n]} />} cursor={{ fill: 'var(--surface-2)' }} /><Bar dataKey="invoiced_total" name="Invoiced" fill={series.primarySoft} radius={[4, 4, 0, 0]} hide={toggle.isHidden('invoiced_total')} isAnimationActive={false} /><Line dataKey="collected_total" name="Collected" stroke={series.good} strokeWidth={2.5} dot={false} hide={toggle.isHidden('collected_total')} isAnimationActive={false} /><Line dataKey="revenue" name="Revenue" stroke={series.mutedText} strokeDasharray="4 4" strokeWidth={1.5} dot={false} hide={toggle.isHidden('revenue')} isAnimationActive={false} /></ComposedChart></ResponsiveContainer></div>}</QueryCard>
      <QueryCard title="Concentration" subtitle="Cumulative share of revenue by account rank" className="span-5" query={summary} isEmpty={() => !accounts.length}>{() => { let running = 0; return <div className="concentration-list">{accounts.slice(0, 8).map((a, i) => { running += a.revenue; const share = revenue ? (a.revenue / revenue) * 100 : 0; const cum = revenue ? (running / revenue) * 100 : 0; return <div key={a.name} className="concentration-row"><span className="num">{i + 1}</span><div><strong>{a.name}</strong><i><em style={{ width: `${cum}%` }} /><b style={{ width: `${share}%` }} /></i></div><b className="num">{percent(share)}</b><small className="num">{percent(cum, 0)} cum.</small></div> })}</div> }}</QueryCard>
    </div>
    <QueryCard title="Account revenue detail" subtitle={rangeSubtitle(summary.data?.range)} query={summary} skeleton="table" isEmpty={() => !accounts.length}>{() => <DataGrid rows={accounts} columns={columns} rowKey={(r) => r.name} defaultSort={{ key: 'revenue', dir: 'desc' }} onRowClick={(r) => filterToAccount(r.name)} csvName="revenue-by-account" dense />}</QueryCard>
  </>
}
