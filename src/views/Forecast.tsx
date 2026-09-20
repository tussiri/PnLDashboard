import { ChevronDown, FlaskConical, RefreshCw, ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from 'recharts'
import { QueryCard } from '../components/CardState'
import { ChartTooltip, LegendToggles, gridProps, monthTick, series, useSeriesToggle, xAxisProps, yAxisProps } from '../components/ChartKit'
import { DataGrid, type Column } from '../components/DataGrid'
import { ForecastingDashboard } from '../components/ForecastingDashboard'
import { useDashboard } from '../context/DashboardContext'
import { useAuth } from '../auth/useAuth'
import { hasAdminToken } from '../services/api'
import type { DeliveryModel, ForecastAccountSummary, ForecastHistoryResponse, ForecastHistoryRow, ForecastMetaResponse, ForecastMetric, ForecastRow, ForecastsResponse, RunMeta, SeriesStatus, TrackRecordResponse, TrackRecordRow } from '../services/apiTypes'
import { queryClient } from '../services/queryClient'
import { monthLabel } from '../services/period'
import { fmtDateTime, money, number, percent, moneyTick } from '../utils'
import { AccuracyBadge, VolatilityChip, coverageCaveat, coverageSummary, deliveryLabel, headlineRow, isAggregateRow, metricLabel } from './forecastShared'
import { DemoNotice, Note, useReportQuery } from './shared'

interface SiteForecastRow { job_number: string; job_name: string; parent_account: string | null; delivery_model: DeliveryModel | null; method: string; volatility: string | null; steps: ForecastRow[]; accuracy: ForecastRow['accuracy']; row: ForecastRow }

/** History rows carry subcontract_cost only when the source has the direct-cost breakdown; a missing series draws nothing rather than zero. */
const metricValue = (r: Pick<ForecastHistoryRow, 'revenue' | 'gross_profit' | 'labor_cost' | 'subcontract_cost'>, metric: ForecastMetric): number | null => (metric === 'subcontract_cost' ? (typeof r.subcontract_cost === 'number' ? r.subcontract_cost : null) : r[metric])

function AccountCoverage({ summary }: { summary: ForecastAccountSummary }) {
  const caveat = coverageCaveat(summary.forecast_coverage_pct)
  const actual = summary.last_closed_actual
  return <div className="account-coverage">
    <div className="account-coverage__facts">
      <div><span>Sites forecast</span><strong className="num">{number(summary.sites_forecast)} / {number(summary.sites_total)}</strong><small>{number(summary.sites_not_forecast)} not forecast</small></div>
      <div><span>Delivery model</span><strong className="num">{number(summary.self_perform_sites)} · {number(summary.subcontracted_sites)}</strong><small>self-performed · subcontracted</small></div>
      <div><span>Last closed revenue</span><strong className="num">{money(actual.revenue)}</strong><small>{summary.last_closed_month ? monthLabel(summary.last_closed_month, 'long') : 'latest closed month'}</small></div>
      <div><span>Subcontract cost</span><strong className="num">{money(actual.subcontract_cost)}</strong><small>labor {money(actual.labor_cost)}</small></div>
      <div><span>Gross profit</span><strong className="num">{money(actual.gross_profit)}</strong><small>{actual.revenue ? percent((actual.gross_profit / actual.revenue) * 100) : '—'} margin</small></div>
      <div className={caveat ? 'is-warn' : ''}><span>Forecast coverage</span><strong className="num">{summary.forecast_coverage_pct === null ? '—' : percent(summary.forecast_coverage_pct, 0)}</strong><small>of last-closed revenue is in the aggregate</small></div>
    </div>
    {caveat && <p className="account-coverage__caveat text-warn"><strong>Coverage below 80%.</strong> {caveat}</p>}
  </div>
}

function MetaValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) return <span className="muted">—</span>
  if (typeof value === 'number') return <span className="num">{Number.isInteger(value) ? value.toLocaleString() : Math.abs(value) < 1 ? value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : value.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
  if (typeof value === 'boolean') return <span>{value ? 'yes' : 'no'}</span>
  if (typeof value === 'string') return <span>{/^\d{4}-\d{2}-01$/.test(value) ? monthLabel(value) : value}</span>
  if (Array.isArray(value)) return <span>{value.every((v) => typeof v !== 'object') ? value.map(String).join(', ') : value.map((v, i) => <MetaValue key={i} value={v} depth={depth + 1} />)}</span>
  if (depth > 2) return <span>{JSON.stringify(value)}</span>
  return <span className="meta-nested">{Object.entries(value as Record<string, unknown>).map(([k, v]) => <span key={k}><em>{k.replace(/_/g, ' ')}</em> <MetaValue value={v} depth={depth + 1} /></span>)}</span>
}

function MetaBlock({ title, data }: { title: string; data: Record<string, unknown> | undefined }) {
  const entries = Object.entries(data ?? {})
  if (!entries.length) return null
  return <div className="meta-block"><h4>{title}</h4><dl>{entries.map(([k, v]) => <div key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd><MetaValue value={v} /></dd></div>)}</dl></div>
}

export function Forecast() {
  const { api, mode, dimensions, toast } = useDashboard()
  const { user } = useAuth()
  const canRebuild = hasAdminToken() || user?.role === 'admin'
  const [metric, setMetric] = useState<ForecastMetric>('revenue')
  const [account, setAccount] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [delivery, setDelivery] = useState<'' | DeliveryModel>('')
  const [rebuilding, setRebuilding] = useState(false)
  const toggle = useSeriesToggle()
  const fq = useMemo(() => ({ metric, account: account || undefined }), [metric, account])
  const forecasts = useReportQuery<ForecastsResponse>('forecasts', (api, signal) => api.forecasts(fq, signal), fq)
  const meta = useReportQuery<ForecastMetaResponse>('forecasts/meta', (api, signal) => api.forecastMeta(signal))
  const history = useReportQuery<ForecastHistoryResponse>('forecasts/history', (api, signal) => api.forecastHistory({ account: account || undefined }, signal), { account })
  const track = useReportQuery<TrackRecordResponse>('forecasts/track-record', (api, signal) => api.forecastTrackRecord({ metric, job_number: '__ALL__' }, signal), { metric })
  const run: RunMeta | null = forecasts.data?.run ?? meta.data?.run ?? null
  // Headline rows: the `__ACCOUNT__` aggregate under an account, `__ALL__` for the portfolio. The whole-portfolio row is never shown under an account.
  const portfolioRows = useMemo(() => headlineRow(forecasts.data?.rows, account), [forecasts.data, account])
  const accountSummary = account ? forecasts.data?.account_summary ?? null : null
  const chart = useMemo(() => {
    type Point = { month: string; actual: number | null; closed: boolean; suspect: string | null; flagged: number | null; partial: number | null; point: number | null; lo: number | null; band: number | null }
    const rows = history.data?.rows ?? []
    const basis = run?.latest_closed_month ?? rows.filter((r) => r.closed).at(-1)?.month
    const byMonth = new Map<string, Point>()
    // Closed history is the fitted series; in-progress months stay visible but are drawn as partial markers, not on the actual line.
    for (const r of rows) byMonth.set(r.month, { month: r.month, actual: r.closed ? metricValue(r, metric) : null, closed: r.closed, suspect: r.suspect, flagged: r.suspect && r.closed ? metricValue(r, metric) : null, partial: !r.closed ? metricValue(r, metric) : null, point: null, lo: null, band: null })
    const last = basis ? byMonth.get(basis) : undefined
    if (last && last.actual !== null) Object.assign(last, { point: last.actual, lo: last.actual, band: 0 })
    // Forecast months may coincide with in-progress months; merge into the same x category so nothing is drawn twice.
    for (const r of portfolioRows) { const existing = byMonth.get(r.forecast_month); const fc = { point: r.point, lo: r.lo, band: r.hi - r.lo }; if (existing) Object.assign(existing, fc); else byMonth.set(r.forecast_month, { month: r.forecast_month, actual: null, closed: false, suspect: null, flagged: null, partial: null, ...fc }) }
    return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-21)
  }, [history.data, portfolioRows, metric, run?.latest_closed_month])
  const siteRows = useMemo<SiteForecastRow[]>(() => {
    const map = new Map<string, SiteForecastRow>()
    for (const r of forecasts.data?.rows ?? []) {
      if (isAggregateRow(r.job_number)) continue
      const entry = map.get(r.job_number) ?? { job_number: r.job_number, job_name: r.job_name, parent_account: r.parent_account ?? null, delivery_model: r.delivery_model ?? null, method: r.method, volatility: r.volatility_class, steps: [], accuracy: r.accuracy, row: r }
      entry.steps.push(r)
      map.set(r.job_number, entry)
    }
    return [...map.values()].map((e) => ({ ...e, steps: e.steps.sort((a, b) => a.horizon_step - b.horizon_step) }))
  }, [forecasts.data])
  const hasDelivery = siteRows.some((r) => r.delivery_model !== null)
  const visibleSiteRows = useMemo(() => (delivery ? siteRows.filter((r) => r.delivery_model === delivery) : siteRows), [siteRows, delivery])
  const horizons = [1, 2, 3]
  const horizonMonth = (h: number) => portfolioRows[h - 1]?.forecast_month ?? siteRows[0]?.steps.find((s) => s.horizon_step === h)?.forecast_month
  const siteColumns: Column<SiteForecastRow>[] = [
    { key: 'job_name', header: 'Site', render: (r) => <><strong>{r.job_name}</strong><span className="muted"> {r.job_number}</span>{r.delivery_model === 'subcontracted' && <span className="tag-chip tag-chip--sub">Subcontracted</span>}</> },
    ...(!account ? [{ key: 'parent_account', header: 'Account', value: (r: SiteForecastRow) => r.parent_account ?? '', render: (r: SiteForecastRow) => r.parent_account ?? <span className="muted">—</span> } as Column<SiteForecastRow>] : []),
    ...(hasDelivery ? [{ key: 'delivery_model', header: 'Delivery', value: (r: SiteForecastRow) => r.delivery_model ?? '', render: (r: SiteForecastRow) => <span className={`tag-chip ${r.delivery_model === 'subcontracted' ? 'tag-chip--sub' : ''}`}>{deliveryLabel(r.delivery_model)}</span> } as Column<SiteForecastRow>] : []),
    { key: 'method', header: 'Method', render: (r) => <span className="method-chip">{r.method.replace(/_/g, ' ')}</span> },
    { key: 'volatility', header: 'Volatility', render: (r) => <VolatilityChip value={r.volatility} /> },
    ...horizons.map((h): Column<SiteForecastRow> => ({ key: `h${h}`, header: `+${h} (${horizonMonth(h) ? monthLabel(horizonMonth(h)!, 'tick') : ''})`, numeric: true, value: (r) => r.steps.find((s) => s.horizon_step === h)?.point ?? null, csv: (r) => { const s = r.steps.find((x) => x.horizon_step === h); return s ? `${s.point} (${s.lo}–${s.hi})` : '' }, render: (r) => { const s = r.steps.find((x) => x.horizon_step === h); return s ? <span className="point-cell"><b>{money(s.point)}</b><small>{money(s.lo)}–{money(s.hi)}</small></span> : '—' } })),
    { key: 'accuracy', header: 'Accuracy', value: (r) => (r.accuracy && r.accuracy.n_backtests >= 3 ? r.accuracy.median_ape : null), csv: (r) => (r.accuracy && r.accuracy.n_backtests >= 3 ? r.accuracy.median_ape : ''), render: (r) => <AccuracyBadge accuracy={r.accuracy} /> },
  ]
  const trackColumns: Column<TrackRecordRow>[] = [
    { key: 'origin_month', header: 'Origin', render: (r) => monthLabel(r.origin_month, 'tick'), csv: (r) => r.origin_month },
    { key: 'forecast_month', header: 'Forecast month', render: (r) => monthLabel(r.forecast_month, 'tick'), csv: (r) => r.forecast_month },
    { key: 'horizon', header: 'h', numeric: true },
    { key: 'method', header: 'Method', render: (r) => r.method.replace(/_/g, ' ') },
    { key: 'point', header: 'Point', numeric: true, render: (r) => money(r.point) },
    { key: 'band', header: '80% band', numeric: true, sortable: false, render: (r) => (r.lo === null || r.hi === null ? <span className="muted" title="No band recorded for this row (portfolio sums carry point only)">—</span> : <span className="num">{money(r.lo)}–{money(r.hi)}</span>), csv: (r) => (r.lo === null || r.hi === null ? '' : `${r.lo}–${r.hi}`) },
    { key: 'actual', header: 'Actual', numeric: true, render: (r) => (r.actual === null ? <span className="muted">not yet closed</span> : money(r.actual)) },
    { key: 'scaled_error', header: 'Scaled error', numeric: true, render: (r) => (r.scaled_error === null ? '—' : r.scaled_error.toFixed(2)) },
    { key: 'in_band', header: 'In band', render: (r) => (r.in_band === null ? <span className="muted">{r.actual === null ? 'pending' : 'no band'}</span> : r.in_band ? <span className="inband inband--yes">In band</span> : <span className="inband inband--no">Outside</span>) },
  ]
  const coverageMeasured = track.data ? track.data.rows.filter((r) => r.in_band !== null) : []
  const coverageFromTrack = coverageMeasured.length ? (coverageMeasured.filter((r) => r.in_band).length / coverageMeasured.length) * 100 : null
  const metaCoverage = coverageSummary(run?.coverage, metric)
  const coverageRate = coverageFromTrack ?? metaCoverage.overall
  const rebuild = async () => {
    setRebuilding(true)
    try { const result = await api.rebuildForecasts(); toast('success', 'Forecast rebuild finished', `${result.sites_forecast} sites forecast · run ${result.run_id}`); queryClient.invalidate(`${mode}/forecasts`) }
    catch (error) { toast('error', 'Forecast rebuild failed', error instanceof Error ? error.message : String(error)) }
    finally { setRebuilding(false) }
  }
  const noRun = forecasts.data !== undefined && !run
  return <>
    <DemoNotice>Seeded forecast run in the v2 engine contract shape; not produced by the engine.</DemoNotice>
    <section className="forecast-hero forecast-hero--governed">
      <div>{run ? <><h2 className="num">{run.engine_version}</h2><p>Latest closed month {monthLabel(run.latest_closed_month, 'long')} · generated {fmtDateTime(run.generated_at)} · horizon {run.horizon_months} months · run {String(run.run_id)}</p></> : <><h2>No validated forecast run</h2><p>No run in the forecast marts; only observed history is shown.</p></>}</div>
      <div className={`model-status ${run ? 'model-status--live' : 'model-status--demo'}`}>{run ? <><span><ShieldCheck size={14} />Validated run</span><strong>{forecasts.data ? `${siteRows.length} sites forecast` : '—'}</strong><small>{forecasts.data?.not_forecast.length ?? 0} not forecast · {metricLabel[metric]}</small></> : <><span><FlaskConical size={14} />Awaiting engine run</span><strong>History only</strong>{mode === 'live' && <button className="secondary-button" onClick={rebuild} disabled={rebuilding || !canRebuild} title={canRebuild ? 'POST /forecasts/rebuild' : 'Requires an administrator session or the admin token'}><RefreshCw size={13} className={rebuilding ? 'spin' : ''} />Rebuild forecasts</button>}</>}</div>
    </section>
    <div className="forecast-toolbar">
      <label><span>Metric</span><select value={metric} onChange={(e) => setMetric(e.target.value as ForecastMetric)}>{(Object.keys(metricLabel) as ForecastMetric[]).map((m) => <option key={m} value={m}>{metricLabel[m]}</option>)}</select></label>
      <label><span>Account</span><select value={account} onChange={(e) => setAccount(e.target.value)}><option value="">Portfolio</option>{(dimensions?.accounts ?? []).map((a) => <option key={a}>{a}</option>)}</select></label>
      {run && mode === 'live' && <button className="secondary-button" onClick={rebuild} disabled={rebuilding || !canRebuild} title={canRebuild ? 'POST /forecasts/rebuild' : 'Requires an administrator session or the admin token'}><RefreshCw size={13} className={rebuilding ? 'spin' : ''} />Rebuild forecasts</button>}
    </div>
    <div className="forecast-kpis">
      {portfolioRows.length ? portfolioRows.map((r) => <div key={r.horizon_step}><span>{monthLabel(r.forecast_month)} · +{r.horizon_step} · {account || 'Portfolio'}</span><strong className="num">{money(r.point)}</strong><small className="num">80% band {money(r.lo)}–{money(r.hi)}</small></div>) : <div><span>Point forecast · {account || 'Portfolio'}</span><strong>—</strong><small>{noRun ? 'No run' : forecasts.data ? (account ? 'No account aggregate in this run' : 'No portfolio row in this run') : 'Loading'}</small></div>}
      <div><span>Measured 80% coverage</span><strong className="num">{coverageRate === null ? '—' : percent(coverageRate, 0)}</strong><small>{coverageMeasured.length ? `${coverageMeasured.length} closed portfolio backtests · target 80%` : metaCoverage.overall !== null ? `run metadata · ${metaCoverage.text}` : 'No measured coverage yet'}</small></div>
      <div><span>Not forecast</span><strong className="num">{number(forecasts.data?.not_forecast.length ?? null)}</strong><small>sites refused by data gates</small></div>
    </div>
    {account && <QueryCard title={`Account coverage · ${account}`} subtitle="Share of last-closed-month actuals covered by the aggregate forecast" className="chart-card--auto" query={forecasts} skeleton="text" isEmpty={(f) => !f.account_summary} emptyTitle="No account summary" emptyHint="The server did not return account_summary for this account.">{() => <AccountCoverage summary={accountSummary ?? forecasts.data!.account_summary!} />}</QueryCard>}
    <div className="dashboard-grid">
      <QueryCard title={`${account || 'Portfolio'} · ${metricLabel[metric]}`} subtitle="Observed history (closed months) with the 3-month point forecast and 80% band · partial and suspect months marked" className="span-8" query={history} isEmpty={(h) => !h.rows.length || !h.rows.some((r) => metricValue(r, metric) !== null)} emptyHint={metric === 'subcontract_cost' ? 'The history endpoint does not carry subcontract cost for this scope.' : 'No closed months in the marts.'}>{() => <div className="chart-with-legend"><LegendToggles series={[{ key: 'actual', name: 'Actual (closed)', color: series.navy }, { key: 'partial', name: 'Partial month', color: series.warn, kind: 'dash' }, { key: 'flagged', name: 'Suspect month', color: series.bad, kind: 'dash' }, { key: 'point', name: 'Forecast', color: series.primary, kind: 'dash' }, { key: 'band', name: '80% band', color: series.primarySoft, kind: 'area' }]} hidden={toggle.hidden} onToggle={toggle.toggle} /><ResponsiveContainer width="100%" height="100%"><ComposedChart data={chart} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}><CartesianGrid {...gridProps} /><XAxis dataKey="month" tickFormatter={monthTick} {...xAxisProps} /><YAxis tickFormatter={moneyTick} {...yAxisProps} /><Tooltip content={<ChartTooltip formatter={(v, n, item) => { if (n === 'lo') return null; if (n === 'band') { const p = item.payload as { lo?: number; band?: number }; return [`${money((p.lo ?? 0))}–${money((p.lo ?? 0) + (p.band ?? 0))}`, '80% band'] } return [money(Number(v)), n] }} footer={(p) => { const row = p[0]?.payload as { suspect?: string | null; closed?: boolean } | undefined; return row?.suspect ? <span className={row.closed ? 'text-bad' : 'text-warn'}>{row.suspect}</span> : null }} />} />{run && <ReferenceLine x={run.latest_closed_month} stroke="var(--muted)" strokeDasharray="3 3" label={{ value: 'Latest closed', position: 'insideTopLeft', fill: 'var(--muted)', fontSize: 10 }} />}<Area dataKey="lo" stackId="band" stroke="none" fill="transparent" isAnimationActive={false} name="lo" hide={toggle.isHidden('band')} /><Area dataKey="band" stackId="band" stroke="none" fill={series.primarySoft} fillOpacity={0.85} isAnimationActive={false} name="band" hide={toggle.isHidden('band')} /><Line dataKey="actual" name="actual" stroke={series.navy} strokeWidth={2.5} dot={false} isAnimationActive={false} hide={toggle.isHidden('actual')} connectNulls /><Line dataKey="point" name="point" stroke={series.primary} strokeWidth={2.5} strokeDasharray="6 4" dot={{ r: 3 }} isAnimationActive={false} hide={toggle.isHidden('point')} connectNulls /><Scatter dataKey="partial" name="partial" fill={series.warn} shape="diamond" isAnimationActive={false} hide={toggle.isHidden('partial')} /><Scatter dataKey="flagged" name="flagged" fill={series.bad} shape="triangle" isAnimationActive={false} hide={toggle.isHidden('flagged')} /></ComposedChart></ResponsiveContainer></div>}</QueryCard>
      <QueryCard title="Assumptions" subtitle="From the run metadata" className="span-4" query={meta} skeleton="text" isEmpty={(m) => !m.run || !m.run.assumptions?.length} emptyTitle="No run assumptions" emptyHint="Assumptions are recorded with each validated run.">{(m) => <ol className="assumptions">{m.run!.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ol>}</QueryCard>
    </div>
    <QueryCard title={`Site forecasts${account ? ` · ${account}` : ''}`} subtitle={`${metricLabel[metric]} · point with 80% band per horizon step · ${delivery ? `${visibleSiteRows.length} of ${siteRows.length} sites` : `${siteRows.length} sites`} · click a row for the engine’s explanation`} query={forecasts} skeleton="table" isEmpty={(f) => !f.run} emptyTitle="No validated forecast run yet" emptyHint="Site rows appear once the engine writes a run." note={<Note>Accuracy badges are shown only when a site has at least 3 walk-forward backtests; otherwise the estimate is labeled unmeasured.</Note>}>{() => <>
      <DataGrid rows={visibleSiteRows} columns={siteColumns} rowKey={(r) => r.job_number} defaultSort={{ key: 'h1', dir: 'desc' }} onRowClick={(r) => setExpanded(expanded === r.job_number ? null : r.job_number)} highlightKey={expanded} csvName={`forecast-${metric}`} pageSize={15} dense emptyTitle="No sites match" emptyHint="Adjust the delivery filter." toolbar={hasDelivery ? <label className="inline-select"><span>Delivery</span><select value={delivery} onChange={(e) => setDelivery(e.target.value as '' | DeliveryModel)} aria-label="Delivery model"><option value="">All</option><option value="self_perform">Self-performed</option><option value="subcontracted">Subcontracted</option></select></label> : undefined} />
      {expanded && (() => { const r = siteRows.find((s) => s.job_number === expanded); if (!r) return null; const first = r.steps[0]; return <div className="forecast-explain"><header><strong>{r.job_name}</strong><button type="button" className="text-button" onClick={() => setExpanded(null)}>Close</button></header><p>{first.explanation}</p><dl><div><dt>History used</dt><dd>{first.n_history} months · inputs {first.input_months.length ? `${monthLabel(first.input_months[0], 'tick')}–${monthLabel(first.input_months.at(-1)!, 'tick')}` : '—'}</dd></div><div><dt>Excluded months</dt><dd>{first.excluded_months.length ? first.excluded_months.map((e) => `${monthLabel(e.month, 'tick')}: ${e.reason}`).join('; ') : 'none'}</dd></div><div><dt>Interval source</dt><dd><MetaValue value={first.interval} /></dd></div><div><dt>Method selection</dt><dd><MetaValue value={first.method_selection} /></dd></div>{first.disruption && <div><dt>Disruption</dt><dd><MetaValue value={first.disruption} /></dd></div>}<div><dt>Engine</dt><dd className="num">{first.engine_version} · status {first.status}</dd></div></dl></div> })()}
    </>}</QueryCard>
    <div className="dashboard-grid">
      <QueryCard title="Not forecast" subtitle="Sites refused by the data gates, with the reason" className="span-4" query={forecasts} skeleton="text" isEmpty={(f) => !f.not_forecast.length} emptyTitle="Every eligible site was forecast">{(f) => <div className="not-forecast">{f.not_forecast.map((s: SeriesStatus) => <div key={`${s.job_number}-${s.metric}`}><strong>{s.job_name}</strong><span>{s.reason}</span><small>{s.n_valid} valid months · last {s.last_valid_month ? monthLabel(s.last_valid_month, 'tick') : '—'}{s.delivery_model ? ` · ${deliveryLabel(s.delivery_model)}` : ''}</small></div>)}</div>}</QueryCard>
      <QueryCard title="Run metadata" subtitle="Dataset, gates, coverage and disruption policy from the run" className="span-8" query={meta} skeleton="text" isEmpty={(m) => !m.run} emptyTitle="No run metadata">{(m) => <div className="meta-grid"><MetaBlock title="Dataset" data={m.run!.dataset} /><MetaBlock title="Gates" data={m.run!.gates} /><MetaBlock title="Coverage" data={m.run!.coverage} /><MetaBlock title="Disruption" data={m.run!.disruption} /><MetaBlock title="Portfolio" data={m.run!.portfolio} /></div>}</QueryCard>
    </div>
    <QueryCard title="Track record" subtitle={`${metricLabel[metric]} · portfolio · every past origin and horizon with the observed outcome`} query={track} skeleton="table" isEmpty={(t) => !t.rows.length} emptyTitle="No track record yet" emptyHint="Backtests accumulate as months close after each run." note={<Note>In-band markers compare the closed actual with the 80% band the run produced at that origin. Measured coverage from run metadata ({metricLabel[metric]}): {metaCoverage.overall !== null ? metaCoverage.text : 'not recorded'}.</Note>}>{(t) => <DataGrid rows={t.rows} columns={trackColumns} rowKey={(r) => `${r.origin_month}-${r.horizon}`} defaultSort={{ key: 'origin_month', dir: 'desc' }} csvName={`track-record-${metric}`} pageSize={18} dense />}</QueryCard>
    <details className="sandbox">
      <summary><span><FlaskConical size={15} />Scenario sandbox</span><em>Browser-only demonstration</em><ChevronDown size={16} className="sandbox__chev" /></summary>
      <div className="sandbox__body">
        <div className="data-notice data-notice--warn"><strong>Sandbox</strong><span>Runs in the browser on a generated 48-month series; never reads the marts and is not used for reporting.</span></div>
        <ForecastingDashboard />
      </div>
    </details>
  </>
}
