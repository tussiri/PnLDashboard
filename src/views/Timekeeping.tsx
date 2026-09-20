import { useMemo } from 'react'
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, LabelList, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { QueryCard } from '../components/CardState'
import { ChartTooltip, LegendToggles, gridProps, series, useSeriesToggle, xAxisProps, yAxisProps } from '../components/ChartKit'
import { DataGrid, type Column } from '../components/DataGrid'
import { KpiCard } from '../components/KpiCard'
import { useDashboard } from '../context/DashboardContext'
import type { TimekeepingSummary } from '../services/apiTypes'
import { fmtDate, money, number, percent, signed } from '../utils'
import { DemoNotice, rangeSubtitle, ScopeLine, useReportingParams, useReportQuery } from './shared'

type JobHours = TimekeepingSummary['by_job'][number]

export function Timekeeping() {
  const { query, params } = useReportingParams()
  const { openJob } = useDashboard()
  const tk = useReportQuery<TimekeepingSummary>('timekeeping/summary', (api, signal) => api.timekeepingSummary(query, signal), params)
  const toggle = useSeriesToggle()
  const k = tk.data?.kpis
  const watchlist = useMemo(() => [...(tk.data?.by_job ?? [])].filter((j) => j.hours > 0).map((j) => ({ ...j, ot_pct: (j.overtime_hours / j.hours) * 100 })).sort((a, b) => b.ot_pct - a.ot_pct).slice(0, 8), [tk.data])
  const columns: Column<JobHours>[] = [
    { key: 'job_name', header: 'Site', render: (r) => <><strong>{r.job_name}</strong><span className="muted"> {r.parent_account}</span></> },
    { key: 'hours', header: 'Worked', numeric: true, render: (r) => number(r.hours) },
    { key: 'overtime_hours', header: 'OT hours', numeric: true, render: (r) => number(r.overtime_hours) },
    { key: 'ot_pct', header: 'OT %', numeric: true, value: (r) => (r.hours ? (r.overtime_hours / r.hours) * 100 : null), className: (r) => ((r.hours ? (r.overtime_hours / r.hours) * 100 : 0) > 15 ? 'text-bad' : (r.hours ? (r.overtime_hours / r.hours) * 100 : 0) > 10 ? 'text-warn' : undefined), render: (r) => percent(r.hours ? (r.overtime_hours / r.hours) * 100 : null) },
    { key: 'employees', header: 'Employees', numeric: true },
  ]
  return <>
    <ScopeLine />
    <DemoNotice>Daily hours are seeded.</DemoNotice>
    <div className="kpi-grid kpi-grid--compact">
      <KpiCard label="Actual hours" loading={tk.loading} value={number(k?.hours)} delta={null} context={`${number(k?.regular_hours)} regular · ${number(k?.overtime_hours)} OT`} favorable="down" />
      <KpiCard label="Overtime" loading={tk.loading} value={number(k?.overtime_hours)} delta={null} context={`${percent(k?.overtime_pct)} of hours`} favorable="down" />
      <KpiCard label="Employees" loading={tk.loading} value={number(k?.employees)} delta={null} context={`${number(k?.punches)} punches`} favorable="none" />
      <KpiCard label="Revenue per hour" loading={tk.loading} value={money(k?.revenue_per_hour, 0)} delta={null} context={rangeSubtitle(tk.data?.range, 'productivity')} />
    </div>
    <div className="dashboard-grid">
      <QueryCard title="Daily hours" subtitle="Last 8 weeks ending the anchor month" className="span-8" query={tk} isEmpty={(t) => !t.daily.length}>{(t) => <div className="chart-with-legend"><LegendToggles series={[{ key: 'hours', name: 'Worked', color: series.primary }, { key: 'overtime_hours', name: 'Overtime', color: series.bad, kind: 'bar' }]} hidden={toggle.hidden} onToggle={toggle.toggle} /><ResponsiveContainer width="100%" height="100%"><ComposedChart data={t.daily} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid {...gridProps} /><XAxis dataKey="work_date" tickFormatter={(v) => fmtDate(v, { month: 'short', day: 'numeric' })} {...xAxisProps} minTickGap={28} /><YAxis tickFormatter={(v) => number(v)} {...yAxisProps} width={44} /><Tooltip content={<ChartTooltip formatter={(v, n) => [`${number(Number(v))} h`, n]} labelFormatter={(l) => fmtDate(String(l), { weekday: 'short', month: 'short', day: 'numeric' })} />} /><Bar dataKey="overtime_hours" name="Overtime" fill={series.bad} fillOpacity={0.7} hide={toggle.isHidden('overtime_hours')} isAnimationActive={false} /><Line dataKey="hours" name="Worked" type="monotone" stroke={series.primary} strokeWidth={2} dot={false} hide={toggle.isHidden('hours')} isAnimationActive={false} /></ComposedChart></ResponsiveContainer></div>}</QueryCard>
      <QueryCard title="Weekday profile" subtitle="Average hours per weekday · last 8 weeks" className="span-4" query={tk} isEmpty={(t) => !t.by_weekday.length}>{(t) => <ResponsiveContainer width="100%" height="100%"><BarChart data={t.by_weekday} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}><CartesianGrid {...gridProps} /><XAxis dataKey="label" {...xAxisProps} /><YAxis tickFormatter={(v) => number(v)} {...yAxisProps} width={40} /><Tooltip content={<ChartTooltip formatter={(v, n) => [`${number(Number(v))} h`, n]} />} cursor={{ fill: 'var(--surface-2)' }} /><Bar dataKey="avg_hours" name="Avg hours" fill={series.teal} radius={[4, 4, 0, 0]} isAnimationActive={false}><LabelList dataKey="avg_hours" position="top" formatter={(value: unknown) => number(Number(value))} fill="var(--text)" fontSize={10} /></Bar></BarChart></ResponsiveContainer>}</QueryCard>
    </div>
    <div className="dashboard-grid">
      <QueryCard title="Hours by branch" subtitle={rangeSubtitle(tk.data?.range, 'hours')} className="span-7" query={tk} isEmpty={(t) => !t.by_branch.length}>{(t) => <ResponsiveContainer width="100%" height="100%"><BarChart data={t.by_branch.slice(0, 10)} layout="vertical" margin={{ left: 4, right: 48, top: 4, bottom: 0 }} barGap={2}><CartesianGrid horizontal={false} stroke="var(--grid)" /><XAxis type="number" tickFormatter={(v) => number(v)} {...xAxisProps} /><YAxis type="category" dataKey="branch" width={118} tickLine={false} axisLine={false} tick={{ fill: 'var(--text)', fontSize: 11 }} /><Tooltip content={<ChartTooltip formatter={(v, n) => [`${number(Number(v))} h`, n]} />} cursor={{ fill: 'var(--surface-2)' }} /><Bar dataKey="hours" name="Worked" fill={series.primary} radius={[0, 4, 4, 0]} isAnimationActive={false}><LabelList dataKey="hours" position="right" formatter={(value: unknown) => number(Number(value))} fill="var(--text)" fontSize={10} /></Bar></BarChart></ResponsiveContainer>}</QueryCard>
      <QueryCard title="Overtime watchlist" subtitle="Highest OT share of hours" className="span-5" query={tk} isEmpty={() => !watchlist.length}>{() => <div className="exception-list">{watchlist.map((j) => <button key={j.job_number} onClick={() => openJob(j.job_number)}><span className={`risk-dot ${j.ot_pct > 15 ? 'risk-dot--critical' : j.ot_pct > 10 ? 'risk-dot--watch' : 'risk-dot--healthy'}`} /><div><strong>{j.job_name}</strong><small>{number(j.overtime_hours)} OT hours · {j.employees} employees</small></div><b className="num">{percent(j.ot_pct)}</b></button>)}</div>}</QueryCard>
    </div>
    <QueryCard title="Hours by site" subtitle={rangeSubtitle(tk.data?.range, 'hours · click a row to open the site')} query={tk} skeleton="table" isEmpty={(t) => !t.by_job.length}>{(t) => <DataGrid rows={t.by_job} columns={columns} rowKey={(r) => r.job_number} defaultSort={{ key: 'hours', dir: 'desc' }} onRowClick={(r) => openJob(r.job_number)} csvName="timekeeping-by-site" pageSize={15} dense />}</QueryCard>
  </>
}
