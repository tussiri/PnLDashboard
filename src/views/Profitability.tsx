import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { QueryCard } from '../components/CardState'
import { MarginScatter } from '../components/Charts'
import { ChartTooltip, gridProps, series, xAxisProps, yAxisProps } from '../components/ChartKit'
import { DataGrid, type Column } from '../components/DataGrid'
import { KpiCard } from '../components/KpiCard'
import { useDashboard } from '../context/DashboardContext'
import type { JobRow, PortfolioSummary } from '../services/apiTypes'
import { money, number, percent, signed, sum } from '../utils'
import { DemoNotice, rangeSubtitle, ScopeLine, StatusBadge, useJobsQuery, useReportingParams, useReportQuery } from './shared'

const TARGET = 25

export function Profitability() {
  const { query, params } = useReportingParams()
  const { openJob } = useDashboard()
  const summary = useReportQuery<PortfolioSummary>('portfolio/summary', (api, signal) => api.portfolioSummary(query, signal), params)
  const jobs = useJobsQuery()
  const [highlight, setHighlight] = useState<string | null>(null)
  const k = summary.data?.kpis, d = summary.data?.deltas
  const active = useMemo(() => (jobs.data?.jobs ?? []).filter((j) => j.revenue > 0), [jobs.data])
  const ranked = useMemo(() => [...active].sort((a, b) => (a.gross_margin_pct ?? 0) - (b.gross_margin_pct ?? 0)), [active])
  const buckets = useMemo(() => {
    const edges = [0, 10, 15, 20, 25, 30, 35, 40, 100]
    return edges.slice(0, -1).map((lo, i) => { const hi = edges[i + 1]; const rows = active.filter((j) => { const m = j.gross_margin_pct ?? 0; return m >= lo && m < hi }); return { label: hi === 100 ? `${lo}%+` : `${lo}–${hi}%`, lo, count: rows.length, revenue: sum(rows, (r) => r.revenue) } })
  }, [active])
  const hours = sum(active, (j) => j.hours)
  const columns: Column<JobRow>[] = [
    { key: 'job_name', header: 'Site', render: (r) => <><strong>{r.job_name}</strong><span className="muted"> {r.parent_account}</span></> },
    { key: 'gross_margin_pct', header: 'Margin', numeric: true, className: (r) => ((r.gross_margin_pct ?? 0) < TARGET - 7 ? 'text-bad' : (r.gross_margin_pct ?? 0) < TARGET ? 'text-warn' : 'text-good'), render: (r) => percent(r.gross_margin_pct) },
    { key: 'revenue', header: 'Revenue', numeric: true, render: (r) => money(r.revenue) },
    { key: 'gross_profit', header: 'Gross profit', numeric: true, render: (r) => money(r.gross_profit) },
    { key: 'gp_hour', header: 'GP / hour', numeric: true, value: (r) => (r.hours ? r.gross_profit / r.hours : null), render: (r) => money(r.hours ? r.gross_profit / r.hours : null, 0) },
    { key: 'labor_variance', header: 'Labor var.', numeric: true, className: (r) => (r.labor_variance === null ? undefined : r.labor_variance > 0 ? 'text-bad' : 'text-good'), render: (r) => (r.labor_variance === null ? '—' : signed(r.labor_variance, (v) => money(v))) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} reasons={r.status_reasons} /> },
  ]
  return <>
    <ScopeLine />
    <DemoNotice>Margins are computed on seeded rows; the 25% target mirrors the demo settings.</DemoNotice>
    <div className="kpi-grid kpi-grid--compact">
      <KpiCard label="Gross profit" loading={summary.loading} value={money(k?.gross_profit)} delta={d?.gross_margin_pts} deltaUnit="pts" context={`${percent(k?.gross_margin_pct)} margin`} trend={summary.data?.monthly.map((m) => m.gross_profit)} />
      <KpiCard label="Below margin target" loading={summary.loading} value={number(k?.jobs_below_margin_target)} delta={null} context={`of ${number(k?.active_jobs)} active sites · ${TARGET}% target`} favorable="down" />
      <KpiCard label="Best site margin" loading={jobs.loading} value={percent(ranked.at(-1)?.gross_margin_pct)} delta={null} context={ranked.at(-1)?.job_name ?? '—'} favorable="none" />
      <KpiCard label="GP per labor hour" loading={jobs.loading} value={money(hours ? sum(active, (j) => j.gross_profit) / hours : null, 0)} delta={null} context={`${number(hours)} hours`} />
    </div>
    <div className="dashboard-grid">
      <QueryCard title="Site profitability matrix" subtitle={`${rangeSubtitle(jobs.data?.range)} · bubble size = hours · hover a row to locate its site`} className="span-8" query={jobs} isEmpty={() => !active.length}>{() => <MarginScatter jobs={active} onSelect={(j) => openJob(j.job_number)} target={TARGET} highlight={highlight} onHover={(j) => setHighlight(j?.job_number ?? null)} />}</QueryCard>
      <QueryCard title="Margin distribution" subtitle="Sites per gross-margin band" className="span-4" query={jobs} isEmpty={() => !active.length}>{() => <ResponsiveContainer width="100%" height="100%"><BarChart data={buckets} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}><CartesianGrid {...gridProps} /><XAxis dataKey="label" {...xAxisProps} tick={{ fill: 'var(--muted)', fontSize: 10 }} /><YAxis allowDecimals={false} {...yAxisProps} width={28} /><Tooltip content={<ChartTooltip formatter={(v, n) => [n === 'Sites' ? String(v) : money(Number(v)), n]} labelFormatter={(l) => `Margin ${l}`} />} cursor={{ fill: 'var(--surface-2)' }} /><Bar dataKey="count" name="Sites" radius={[4, 4, 0, 0]} isAnimationActive={false}>{buckets.map((b) => <Cell key={b.label} fill={b.lo < TARGET - 7 ? series.bad : b.lo < TARGET ? series.warn : series.good} />)}<LabelList dataKey="count" position="top" fill="var(--text)" fontSize={10} formatter={(value: unknown) => (Number(value) ? String(value) : '')} /></Bar></BarChart></ResponsiveContainer>}</QueryCard>
    </div>
    <QueryCard title="Lowest-margin sites" subtitle={`${rangeSubtitle(jobs.data?.range)} · sorted ascending · click to open`} query={jobs} skeleton="table" isEmpty={() => !ranked.length}>{() => <DataGrid rows={ranked} columns={columns} rowKey={(r) => r.job_number} defaultSort={{ key: 'gross_margin_pct', dir: 'asc' }} onRowClick={(r) => openJob(r.job_number)} onRowHover={(r) => setHighlight(r?.job_number ?? null)} highlightKey={highlight} csvName="site-margins" pageSize={12} dense />}</QueryCard>
  </>
}
