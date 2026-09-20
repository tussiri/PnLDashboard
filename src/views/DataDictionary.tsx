import { Database } from 'lucide-react'
import { QueryCard } from '../components/CardState'
import { DataGrid, type Column } from '../components/DataGrid'
import { useDashboard } from '../context/DashboardContext'
import type { AppSetting, FreshnessResource, FreshnessResponse, SettingsResponse, SourceStatus } from '../services/apiTypes'
import { monthLabel } from '../services/period'
import { fmtDateTime, number, relativeTime } from '../utils'
import { DemoNotice, Note, useReportQuery } from './shared'

export const sourceDisplayName: Record<string, string> = { winteam_api: 'WinTeam API (incremental sync)', finance_reference: 'WinTeam exports (Finance reference database)' }

const metrics: [string, string, string][] = [
  ['Revenue', 'Closed months: job-cost P&L revenue from the WinTeam job cost report, by service month (mart.job_month.revenue). Months still in progress: AR invoice revenue attributed to the service month. On the WinTeam API source every month uses AR invoice revenueTotal. Invoiced and collected totals are separate billing measures and are not recognized revenue.', 'Month · job / account / region / company'],
  ['Labor cost', 'Closed months: job-cost direct labor from the P&L. Month in progress: timekeeping hours × the job’s trailing closed-month average rate (direct labor ÷ actual hours); labor/pace reports this basis in method_notes.labor_cost_basis. On the WinTeam API source labor is timekeeping labor cost by day for every month.', 'Month · job'],
  ['Direct cost', 'Labor + payroll taxes & insurance + subcontractors + supplies & materials + other direct cost, each carried as its own line from the job-cost P&L (finance reference source). The WinTeam API source carries labor and payroll burden only.', 'Month · job'],
  ['Gross profit', 'Revenue − direct cost. With the finance reference source every direct-cost line above is deducted; on the WinTeam API source it is revenue − labor − payroll burden and vendor AP is reported separately.', 'Month · job'],
  ['Gross margin %', 'Gross profit ÷ revenue. Sites with zero revenue report null.', 'Month · job'],
  ['Labor % of revenue', 'Labor cost ÷ revenue, compared with target_labor_pct from settings.', 'Month · job / account'],
  ['Labor variance', 'Labor cost − budget labor. Null when the site has no labor budget in the range; such sites are excluded from variance totals and the labor-over-budget rule.', 'Range · job'],
  ['Subcontract / supplies vs budget', 'Actuals from the job-cost P&L lines (finance reference source) against the job budget; on the WinTeam API source these lines carry budgets only.', 'Range · portfolio'],
  ['Overtime', 'Derived from timekeeping per the overtime_rule setting; OT % = overtime hours ÷ hours. Overtime cost estimate = OT hours × blended hourly labor × overtime_multiplier.', 'Week · employee / job'],
  ['AR aging', 'Open invoices as of the aging snapshot date (source.ar_as_of) in the WinTeam aging groups: current, 1-30, 31-60, 61-90, 90+. collectible_open excludes intercompany and settlement customers per the ar_treatment_rules setting; by_customer rows carry is_collectible.', 'Snapshot · customer / company'],
  ['AP open balance', 'Real open vendor balance and past-due amount from the latest vendor aging snapshot (finance reference source); invoiced and paid cover the selected range.', 'Snapshot · vendor'],
  ['DSO', 'Open AR ÷ (trailing-3-month revenue ÷ 91). Null when trailing revenue is zero.', 'Point in time · portfolio / account'],
  ['Weighted AR days', 'Open-amount-weighted days outstanding across a site’s open invoices.', 'Point in time · job / account'],
  ['Site status', 'Critical when gross margin < target − margin_critical_delta_pts, or labor over budget > labor_over_budget_critical_pct, or OT > ot_critical_pct of hours, or weighted AR days > ar_days_critical; Watch at the corresponding watch thresholds; else Healthy. Reasons are returned with each site.', 'Range · job'],
  ['Company / delivery model', 'Legal entity (company) and delivery_model (self_perform | subcontracted) from the job master; the Company filter matches mart.job_month.company exactly.', 'Job'],
  ['Map placement', 'geo_precision = exact when the site address was geocoded; city_center when the site is placed from sources/geo/city_centroids.json (approximate, for map placement only).', 'Job'],
  ['Period ranges', 'MTD = anchor month; QTD = anchor quarter to the anchor month; YTD = January to the anchor month; T12M = 12 months ending at the anchor month. Deltas compare with the equivalent prior range. Trend charts always show the trailing 12 months.', 'Server-side'],
  ['Labor pace', 'Month-end projection of labor for the month in progress: day-of-week weighted when daily data exists, otherwise calendar proration. Separate from the governed forecast.', 'Month in progress · portfolio / account / job'],
  ['Governed forecast', 'Server-side engine v2 output per site and metric: point, 80% band, method, gates and walk-forward accuracy. Accuracy is claimed only with ≥ 3 backtests. Browser scenarios are never forecasts.', 'Run · job / portfolio'],
]

export function DataDictionary() {
  const { mode, systemStatus } = useDashboard()
  const freshness = useReportQuery<FreshnessResponse>('data/freshness', (api, signal) => api.freshness(signal))
  const settings = useReportQuery<SettingsResponse>('settings', (api, signal) => api.settings(signal))
  const sources: SourceStatus[] = freshness.data?.sources ?? systemStatus?.sources ?? []
  const sourceColumns: Column<SourceStatus>[] = [
    { key: 'name', header: 'Source', render: (r) => <><strong>{sourceDisplayName[r.name] ?? r.name}</strong><span className="muted"> {r.name}</span></> },
    { key: 'configured', header: 'Configured', render: (r) => (r.configured ? 'yes' : 'no') },
    { key: 'enabled', header: 'Enabled', render: (r) => (r.enabled ? 'yes' : 'no') },
    { key: 'last_status', header: 'Last run', render: (r) => <span className={`source-state source-state--${(r.last_status ?? 'unknown').toLowerCase()}`}>{r.last_status ?? 'never run'}</span> },
    { key: 'last_completed_at', header: 'Completed', render: (r) => <>{fmtDateTime(r.last_completed_at)}<span className="muted"> · {relativeTime(r.last_completed_at)}</span></>, csv: (r) => r.last_completed_at },
    { key: 'records', header: 'Records', numeric: true, render: (r) => number(r.records) },
  ]
  const resourceColumns: Column<FreshnessResource>[] = [
    { key: 'resource_name', header: 'Resource', render: (r) => <strong>{r.resource_name}</strong> },
    { key: 'last_status', header: 'Last status', render: (r) => <span className={`source-state source-state--${(r.last_status ?? 'unknown').toLowerCase()}`}>{r.last_status ?? 'never run'}</span> },
    { key: 'last_completed_at', header: 'Completed', render: (r) => <>{fmtDateTime(r.last_completed_at)}<span className="muted"> · {relativeTime(r.last_completed_at)}</span></>, csv: (r) => r.last_completed_at },
    { key: 'records_fetched', header: 'Fetched', numeric: true, render: (r) => number(r.records_fetched) },
    { key: 'records_inserted', header: 'Inserted', numeric: true, render: (r) => number(r.records_inserted) },
    { key: 'watermark_value', header: 'Watermark', render: (r) => <span className="num">{r.watermark_value ?? '—'}</span> },
    { key: 'seconds_since_last_completion', header: 'Age', numeric: true, className: (r) => ((r.seconds_since_last_completion ?? 0) > 86_400 ? 'text-bad' : undefined), render: (r) => (r.seconds_since_last_completion === null ? '—' : r.seconds_since_last_completion < 3600 ? `${Math.round(r.seconds_since_last_completion / 60)} min` : `${(r.seconds_since_last_completion / 3600).toFixed(1)} h`) },
  ]
  const settingColumns: Column<AppSetting>[] = [
    { key: 'key', header: 'Key', render: (r) => <strong className="num">{r.key}</strong> },
    { key: 'value', header: 'Value', render: (r) => <span className="num">{typeof r.value === 'object' && r.value !== null ? JSON.stringify(r.value) : String(r.value ?? '—')}</span> },
    { key: 'description', header: 'Description' },
    { key: 'updated_at', header: 'Updated', render: (r) => fmtDateTime(r.updated_at), csv: (r) => r.updated_at },
  ]
  const primary = freshness.data?.sources?.find((s) => s.enabled && (s.records ?? 0) > 0) ?? systemStatus?.sources?.find((s) => s.enabled && (s.records ?? 0) > 0)
  return <>
    <DemoNotice>Freshness rows and settings are demo placeholders.</DemoNotice>
    <QueryCard title="Source runs" subtitle="Server-side sources · the warehouse holds one at a time" query={freshness} skeleton="table" isEmpty={() => !sources.length} emptyTitle="No source status" emptyHint="This API build does not report per-source runs." action={<span className={`source-state source-state--${mode === 'live' ? 'ready' : 'mocked'}`}><Database size={12} />{mode === 'live' ? (primary ? `Primary: ${sourceDisplayName[primary.name] ?? primary.name}` : 'Live marts') : 'Demo'}</span>} note={<Note>Loading the finance reference replaces every other source’s data (settings are kept); a WinTeam API sync likewise rebuilds the marts from its own raw tables.</Note>}>{() => <DataGrid rows={sources} columns={sourceColumns} rowKey={(r) => r.name} csvName="source-runs" dense />}</QueryCard>
    <QueryCard title="Source freshness" subtitle={freshness.data?.marts ? `Marts: latest month ${freshness.data.marts.latest_month ? monthLabel(freshness.data.marts.latest_month) : '—'} · rebuilt ${fmtDateTime(freshness.data.marts.rebuilt_at)} · ${number(freshness.data.marts.job_month_rows)} job-month rows` : 'Per-resource sync status from the ingestion worker'} query={freshness} skeleton="table" isEmpty={(f) => !f.resources.length} emptyTitle="No resources configured" emptyHint="WINTEAM_RESOURCES is empty; nothing has been synced.">{(f) => <DataGrid rows={f.resources} columns={resourceColumns} rowKey={(r) => r.resource_name} csvName="source-freshness" dense />}</QueryCard>
    <QueryCard title="Metric catalog" subtitle="Definitions · API contract v1 and the finance reference source" query={freshness} skeleton="table">{() => <div className="detail-table-wrap"><table className="detail-table metric-table"><thead><tr><th>Metric</th><th>Definition</th><th>Grain</th></tr></thead><tbody>{metrics.map(([name, definition, grain]) => <tr key={name}><td><strong>{name}</strong></td><td>{definition}</td><td className="muted">{grain}</td></tr>)}</tbody></table></div>}</QueryCard>
    <QueryCard title="Operational settings" subtitle="ops.app_setting · read-only here; edit under Administration" query={settings} skeleton="table" isEmpty={(s) => !s.settings.length} emptyTitle="No settings">{(s) => <DataGrid rows={s.settings} columns={settingColumns} rowKey={(r) => r.key} csvName="settings" dense />}</QueryCard>
  </>
}
