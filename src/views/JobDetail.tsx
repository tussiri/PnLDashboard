import { ArrowLeft } from 'lucide-react'
import { useMemo } from 'react'
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { QueryCard } from '../components/CardState'
import { ChartTooltip, LegendToggles, gridProps, monthTick, series, useSeriesToggle, xAxisProps, yAxisProps } from '../components/ChartKit'
import { DataGrid, type Column } from '../components/DataGrid'
import { KpiCard } from '../components/KpiCard'
import { useDashboard, useQueryKey } from '../context/DashboardContext'
import { useApiQuery } from '../hooks/useApiQuery'
import type { ArInvoiceRow, ForecastMetric, ForecastRow, JobDetailResponse } from '../services/apiTypes'
import { monthLabel } from '../services/period'
import { fmtDate, money, moneyFull, number, percent, signed, moneyTick } from '../utils'
import { AccuracyBadge, metricLabel } from './forecastShared'
import { DemoNotice, StatusBadge } from './shared'

export function JobDetail({ jobNumber }: { jobNumber: string }) {
  const { api, ready, navigate } = useDashboard()
  const key = useQueryKey()
  const detail = useApiQuery<JobDetailResponse>(ready ? key(`jobs/${jobNumber}`) : null, (signal) => api.job(jobNumber, 24, signal), [api])
  const toggle = useSeriesToggle()
  const job = detail.data?.job
  const history = detail.data?.history ?? []
  const forecastByMetric = useMemo(() => {
    const rows = detail.data?.forecast?.rows ?? []
    const map = new Map<ForecastMetric, ForecastRow[]>()
    for (const row of rows) map.set(row.metric, [...(map.get(row.metric) ?? []), row].sort((a, b) => a.horizon_step - b.horizon_step))
    return map
  }, [detail.data])
  const forecastChart = useMemo(() => {
    const rows = forecastByMetric.get('revenue') ?? []
    const last = history.at(-1)
    return [...history.slice(-12).map((h) => ({ month: h.month, actual: h.revenue, point: null as number | null, lo: null as number | null, band: null as number | null })), ...(last ? [{ month: last.month, actual: last.revenue, point: last.revenue, lo: last.revenue, band: 0 }] : []).slice(0, 0), ...rows.map((r) => ({ month: r.forecast_month, actual: null, point: r.point, lo: r.lo, band: r.hi - r.lo }))]
  }, [forecastByMetric, history])
  const flagged = history.filter((h) => h.data_quality_status && h.data_quality_status !== 'ok')
  const flagReasons = [...new Set(flagged.flatMap((h) => h.quality_notes ?? []))]
  const invoiceColumns: Column<ArInvoiceRow>[] = [
    { key: 'invoice_number', header: 'Invoice', render: (r) => <strong className="num">{r.invoice_number}</strong> },
    { key: 'invoice_date', header: 'Invoiced', render: (r) => fmtDate(r.invoice_date), csv: (r) => r.invoice_date },
    { key: 'terms', header: 'Terms', render: (r) => r.terms ?? '—' },
    { key: 'days_outstanding', header: 'Days', numeric: true, className: (r) => ((r.days_outstanding ?? 0) > 60 ? 'text-bad' : undefined) },
    { key: 'open_balance', header: 'Open', numeric: true, render: (r) => moneyFull(r.open_balance) },
  ]
  const back = <button className="back-button" onClick={() => navigate('jobs')}><ArrowLeft size={15} />Back to sites</button>
  if (detail.error && !detail.data) return <>{back}<QueryCard title={`Site ${jobNumber}`} query={detail}>{() => null}</QueryCard></>
  const margin = job ? (job.gross_margin_pct ?? (job.revenue ? (job.gross_profit / job.revenue) * 100 : null)) : null
  return <>
    {back}
    <DemoNotice>History, schedule, invoices and forecast for this site are seeded.</DemoNotice>
    {job ? <div className="job-header"><div><StatusBadge status={job.status} reasons={job.status_reasons} /><h2>{job.job_name}{job.delivery_model === 'subcontracted' && <span className="tag-chip tag-chip--sub">Subcontracted</span>}</h2><p>{job.parent_account} · {job.city}, {job.state_province} {job.country_code} · {job.service_type} · {job.vertical}{job.company ? ` · ${job.company}` : ''}</p>{job.status_reasons.length > 0 && <ul className="job-header__reasons">{job.status_reasons.map((r) => <li key={r}>{r}</li>)}</ul>}</div><div><span className="num">{job.job_number}</span><strong>{job.branch}</strong><small>{job.manager_name}</small><small>{job.is_active ? 'Active' : `Inactive · last work ${fmtDate(job.last_work_date)}`}</small></div></div> : <div className="job-header job-header--loading" aria-busy="true" />}
    <div className="kpi-grid kpi-grid--compact">
      <KpiCard label="Revenue · T12M" loading={detail.loading} value={money(job?.revenue)} delta={null} context={job?.budget_revenue ? `${signed(((job.revenue - job.budget_revenue) / job.budget_revenue) * 100, (v) => percent(v))} vs budget` : 'No revenue budget'} trend={history.map((h) => h.revenue)} />
      <KpiCard label="Gross profit" loading={detail.loading} value={money(job?.gross_profit)} delta={null} context={`${percent(margin)} margin`} trend={history.map((h) => h.gross_profit)} />
      <KpiCard label="Hours" loading={detail.loading} value={number(job?.hours)} delta={job?.scheduled_hours ? ((job.hours - job.scheduled_hours) / job.scheduled_hours) * 100 : null} deltaLabel="vs scheduled" context={`${number(job?.scheduled_hours)} scheduled · ${percent(job?.hours ? (job.overtime_hours / job.hours) * 100 : null)} OT`} trend={history.map((h) => h.hours)} favorable="down" />
      <KpiCard label="Open AR" loading={detail.loading} value={money(job?.ar_open)} delta={null} context={job?.days_outstanding_weighted !== null && job?.days_outstanding_weighted !== undefined ? `${Math.round(job.days_outstanding_weighted)} weighted days` : 'No open invoices'} favorable="down" />
    </div>
    <div className="dashboard-grid">
      <QueryCard title="24-month history" subtitle="Revenue, labor and gross profit by service month · USD" className="span-8" query={detail} isEmpty={(d) => !d.history.length} emptyHint="No mart rows for this site." note={flagged.length ? `${flagged.length} of ${history.length} months carry data-quality flags${flagReasons.length ? ` (${flagReasons.join(', ')})` : ''}; the marts keep them but the forecast engine may exclude them.` : undefined}>{(d) => <div className="chart-with-legend"><LegendToggles series={[{ key: 'revenue', name: 'Revenue', color: series.primary }, { key: 'labor_cost', name: 'Labor', color: series.warn }, { key: 'gross_profit', name: 'Gross profit', color: series.good }, { key: 'budget_revenue', name: 'Revenue budget', color: series.mutedText, kind: 'dash' }]} hidden={toggle.hidden} onToggle={toggle.toggle} /><ResponsiveContainer width="100%" height="100%"><ComposedChart data={d.history} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid {...gridProps} /><XAxis dataKey="month" tickFormatter={monthTick} {...xAxisProps} /><YAxis tickFormatter={moneyTick} {...yAxisProps} /><Tooltip content={<ChartTooltip formatter={(v, n) => [money(Number(v)), n]} />} /><Line dataKey="revenue" name="Revenue" stroke={series.primary} strokeWidth={2.5} dot={false} hide={toggle.isHidden('revenue')} isAnimationActive={false} /><Line dataKey="labor_cost" name="Labor" stroke={series.warn} strokeWidth={2} dot={false} hide={toggle.isHidden('labor_cost')} isAnimationActive={false} /><Line dataKey="gross_profit" name="Gross profit" stroke={series.good} strokeWidth={2} dot={false} hide={toggle.isHidden('gross_profit')} isAnimationActive={false} /><Line dataKey="budget_revenue" name="Revenue budget" stroke={series.mutedText} strokeDasharray="4 4" strokeWidth={1.5} dot={false} hide={toggle.isHidden('budget_revenue')} isAnimationActive={false} /></ComposedChart></ResponsiveContainer></div>}</QueryCard>
      <QueryCard title="Schedule vs actual" subtitle="Last 13 weeks · hours" className="span-4" query={detail} isEmpty={(d) => !d.schedule_vs_actual.length} emptyHint="No schedule rows for this site.">{(d) => <ResponsiveContainer width="100%" height="100%"><BarChart data={d.schedule_vs_actual} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={1}><CartesianGrid {...gridProps} /><XAxis dataKey="week_start" tickFormatter={(v) => fmtDate(v, { month: 'short', day: 'numeric' })} {...xAxisProps} tick={{ fill: 'var(--muted)', fontSize: 9 }} /><YAxis tickFormatter={(v) => number(v)} {...yAxisProps} width={40} /><Tooltip content={<ChartTooltip formatter={(v, n) => [`${number(Number(v))} h`, n]} labelFormatter={(l) => `Week of ${fmtDate(String(l))}`} />} cursor={{ fill: 'var(--surface-2)' }} /><Bar dataKey="scheduled_hours" name="Scheduled" fill={series.primarySoft} radius={[3, 3, 0, 0]} isAnimationActive={false} /><Bar dataKey="actual_hours" name="Actual" fill={series.primary} radius={[3, 3, 0, 0]} isAnimationActive={false} /><Bar dataKey="overtime_hours" name="Overtime" fill={series.bad} radius={[3, 3, 0, 0]} isAnimationActive={false} /></BarChart></ResponsiveContainer>}</QueryCard>
    </div>
    <div className="dashboard-grid">
      <QueryCard title="Governed forecast" subtitle={detail.data?.forecast ? `Revenue · basis ${monthLabel(forecastByMetric.get('revenue')?.[0]?.basis_month ?? '')} · 80% band` : 'Engine v2 site forecast'} className="span-7" query={detail} isEmpty={(d) => !d.forecast || !d.forecast.rows.length} emptyTitle="Not forecast" emptyHint="This site did not pass the engine’s data gates (history length, staleness or anomaly exclusion) in the latest run.">{() => <div className="forecast-detail"><ResponsiveContainer width="100%" height={220}><ComposedChart data={forecastChart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid {...gridProps} /><XAxis dataKey="month" tickFormatter={monthTick} {...xAxisProps} /><YAxis tickFormatter={moneyTick} {...yAxisProps} /><Tooltip content={<ChartTooltip formatter={(v, n) => (n === 'lo' ? null : [money(Number(v)), n === 'band' ? 'Band width' : n])} />} /><Area dataKey="lo" stackId="band" stroke="none" fill="transparent" isAnimationActive={false} name="lo" /><Area dataKey="band" stackId="band" stroke="none" fill={series.primarySoft} fillOpacity={0.8} isAnimationActive={false} name="band" /><Line dataKey="actual" name="Actual" stroke={series.navy} strokeWidth={2.5} dot={false} isAnimationActive={false} /><Line dataKey="point" name="Forecast" stroke={series.primary} strokeWidth={2.5} strokeDasharray="6 4" dot={{ r: 3 }} isAnimationActive={false} /></ComposedChart></ResponsiveContainer><table className="mini-table"><thead><tr><th>Metric</th><th>Method</th><th>Volatility</th>{[1, 2, 3].map((h) => <th key={h} className="align-right">+{h}</th>)}<th>Accuracy</th></tr></thead><tbody>{(['revenue', 'gross_profit', 'labor_cost', 'subcontract_cost'] as ForecastMetric[]).map((metric) => { const rows = forecastByMetric.get(metric) ?? []; if (!rows.length) return null; return <tr key={metric}><td><strong>{metricLabel[metric]}</strong></td><td>{rows[0].method}</td><td>{rows[0].volatility_class}</td>{rows.map((r) => <td key={r.horizon_step} className="align-right num"><b>{money(r.point)}</b><small>{money(r.lo)}–{money(r.hi)}</small></td>)}<td><AccuracyBadge accuracy={rows[0].accuracy} /></td></tr> })}</tbody></table>{forecastByMetric.get('revenue')?.[0] && <p className="forecast-explanation">{forecastByMetric.get('revenue')![0].explanation}</p>}</div>}</QueryCard>
      <QueryCard title="Open invoices" subtitle={`${detail.data?.invoices.length ?? 0} invoices · ${money(job?.ar_open)} open`} className="span-5" query={detail} skeleton="table" isEmpty={(d) => !d.invoices.length} emptyTitle="No open invoices" emptyHint="This site has nothing outstanding.">{(d) => <DataGrid rows={d.invoices} columns={invoiceColumns} rowKey={(r) => r.invoice_number} defaultSort={{ key: 'days_outstanding', dir: 'desc' }} csvName={`invoices-${jobNumber}`} dense maxHeight={320} />}</QueryCard>
    </div>
    {job && <div className="job-facts">
      <section><h3>Labor & timekeeping · T12M</h3><dl><div><dt>Scheduled hours</dt><dd className="num">{number(job.scheduled_hours)}</dd></div><div><dt>Actual hours</dt><dd className="num">{number(job.hours)}</dd></div><div><dt>Overtime</dt><dd className="num">{number(job.overtime_hours)} ({percent(job.hours ? (job.overtime_hours / job.hours) * 100 : null)})</dd></div><div><dt>Labor vs budget</dt><dd className={`num ${job.labor_variance === null ? '' : job.labor_variance > 0 ? 'text-bad' : 'text-good'}`}>{job.labor_variance === null ? 'No budget' : signed(job.labor_variance, (v) => money(v))}</dd></div><div><dt>Employees</dt><dd className="num">{number(job.employee_count)}</dd></div></dl></section>
      <section><h3>Billing</h3><dl><div><dt>Invoiced · T12M</dt><dd className="num">{money(job.invoiced_total)}</dd></div><div><dt>Collected · T12M</dt><dd className="num">{money(job.collected_total)}</dd></div><div><dt>Last invoice</dt><dd>{fmtDate(job.last_invoice_date)}</dd></div><div><dt>Customer number</dt><dd className="num">{job.customer_number ?? '—'}</dd></div><div><dt>Months reporting</dt><dd className="num">{job.months_reporting}</dd></div></dl></section>
      <section><h3>Site</h3><dl><div><dt>Manager</dt><dd>{job.manager_name || '—'}</dd></div><div><dt>Region / branch</dt><dd>{job.region} / {job.branch}</dd></div><div><dt>Service type</dt><dd>{job.service_type}</dd></div><div><dt>Vertical</dt><dd>{job.vertical}</dd></div><div><dt>Started</dt><dd>{fmtDate(job.date_to_start)}</dd></div>{job.company !== undefined && <div><dt>Company</dt><dd>{job.company ?? '—'}</dd></div>}{job.delivery_model !== undefined && <div><dt>Delivery model</dt><dd>{job.delivery_model === 'subcontracted' ? 'Subcontracted' : job.delivery_model === 'self_perform' ? 'Self-performed' : '—'}</dd></div>}<div><dt>Coordinates</dt><dd className="num">{job.latitude !== null && job.longitude !== null ? `${job.latitude.toFixed(3)}, ${job.longitude.toFixed(3)}` : 'Not geocoded'}</dd></div>{job.geo_precision === 'city_center' && <div><dt>Map placement</dt><dd><span className="tag-chip tag-chip--geo">Approximate city-center placement</span></dd></div>}</dl></section>
    </div>}
  </>
}
