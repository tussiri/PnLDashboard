/**
 * DemoApi - synthesizes every contract response shape from src/data/seed.ts.
 * Deterministic, filter-aware, and labeled: every payload carries
 * source.mode = "empty" so the UI can never mistake it for live data.
 */
import {
  DEMO_AR_AS_OF, DEMO_AS_OF, DEMO_LATEST_MONTH, DEMO_PACE_AS_OF, DEMO_PACE_MONTH, demoApMonths, demoEmployees,
  demoInvoices, demoJobMeta, demoJobMonths, demoMonths, demoPartialMonth, demoResources, demoSettings, demoVendors, demoVendors as vendors,
  mulberry32, paceWeights, type DemoJobMeta, type DemoJobMonth,
} from '../data/seed'
import { ApiError, type LiveApi } from './api'
import type {
  AccountRow, AgingBucketKey, AgingCustomer, AlertRow, AppSetting, ArInvoiceRow, ArInvoicesQuery, BudgetLine, CostBreakdown, DeliveryModel, ExecutiveAccount, ExecutiveBusinessUnit, ExecutiveLaborPl, ExecutiveLaborPlQuery, ExecutiveLaborRow, ExecutiveVendorBlock, ForecastAccuracy, ForecastHistoryRow,
  ForecastMetric, ForecastRow, ForecastsQuery, GeoPrecision, GroupTotals, IsoMonth, JobRow, JobStatus, KeyAccountDimension, LaborPaceQuery, OtherAccountDimension, PaceRow, Period, RangeBlock,
  ReportingQuery, RunMeta, ScopeBlock, ScopeMode, SeriesStatus, SourceBlock, SourceStatus, TrackRecordQuery, TrackRecordRow,
} from './apiTypes'
import { addMonths, daysInMonth, listMonths, priorRange, resolveRange } from './period'

export type DashboardApi = LiveApi

const source: SourceBlock = { mode: 'empty', as_of: DEMO_AS_OF, latest_month: DEMO_LATEST_MONTH, stale: false, primary_source: 'none', ar_as_of: null }

/** Demo legal entities, delivery models and geo precision are derived deterministically from the seeded site so the finance-reference UI paths render. */
export const demoCompanyOf = (meta: DemoJobMeta): string => (meta.site.country === 'Canada' ? 'Crane IFS Canada ULC' : meta.site.region === 'Northeast' || meta.site.region === 'Southeast' ? 'Crane IFS East LLC' : 'Crane IFS West LLC')
export const demoDeliveryModelOf = (meta: DemoJobMeta): DeliveryModel => (meta.index % 7 === 3 ? 'subcontracted' : 'self_perform')
export const demoGeoPrecisionOf = (meta: DemoJobMeta): GeoPrecision => (meta.index % 5 === 0 ? 'city_center' : 'exact')
/** Intercompany affiliate whose receivables are excluded from the collectible total (ar_treatment_rules). */
export const DEMO_NON_COLLECTIBLE_ACCOUNT = 'Harbor Properties'

/**
 * Split the seeded burden into the reference-source direct-cost lines. The split keeps
 * the identity gross_profit = revenue - labor - (payroll T&I + subcontract + supplies + other)
 * because the four parts always sum to burden_cost exactly.
 */
function breakdownOf(labor: number, burden: number, model: DeliveryModel): Required<CostBreakdown> {
  const shares = model === 'subcontracted' ? { ti: 0.4, sub: 0.4, sup: 0.12 } : { ti: 0.62, sub: 0, sup: 0.23 }
  const payroll_ti_cost = Math.round(burden * shares.ti)
  const subcontract_cost = Math.round(burden * shares.sub)
  const supplies_cost = Math.round(burden * shares.sup)
  const other_direct_cost = burden - payroll_ti_cost - subcontract_cost - supplies_cost
  return { payroll_ti_cost, subcontract_cost, supplies_cost, other_direct_cost, direct_cost: labor + burden }
}
const sumBreakdown = (rows: Required<CostBreakdown>[]): Required<CostBreakdown> => ({
  payroll_ti_cost: sum(rows, (r) => r.payroll_ti_cost), subcontract_cost: sum(rows, (r) => r.subcontract_cost), supplies_cost: sum(rows, (r) => r.supplies_cost), other_direct_cost: sum(rows, (r) => r.other_direct_cost), direct_cost: sum(rows, (r) => r.direct_cost),
})
const breakdownFor = (metas: DemoJobMeta[], rowsOf: (meta: DemoJobMeta) => DemoJobMonth[]): Required<CostBreakdown> => sumBreakdown(metas.map((meta) => { const rows = rowsOf(meta); return breakdownOf(sum(rows, (r) => r.labor_cost), sum(rows, (r) => r.burden_cost), demoDeliveryModelOf(meta)) }))

const sum = <T,>(rows: T[], pick: (row: T) => number | null | undefined) => rows.reduce((total, row) => total + (pick(row) ?? 0), 0)
const round1 = (value: number) => Math.round(value * 10) / 10
const pct = (numerator: number, denominator: number): number | null => (denominator ? round1((numerator / denominator) * 100) : null)
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); const mid = Math.floor(s.length / 2); return s.length ? (s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) : 0 }

const settingNumber = (key: string): number => Number(demoSettings.find((s) => s.key === key)?.value ?? 0)
const thresholds = () => ({
  marginTarget: settingNumber('target_gross_margin_pct'), marginCriticalDelta: settingNumber('margin_critical_delta_pts'),
  laborWatch: settingNumber('labor_over_budget_watch_pct'), laborCritical: settingNumber('labor_over_budget_critical_pct'),
  otWatch: settingNumber('ot_watch_pct'), otCritical: settingNumber('ot_critical_pct'),
  arWatch: settingNumber('ar_days_watch'), arCritical: settingNumber('ar_days_critical'),
  targetLaborPct: settingNumber('target_labor_pct'),
})

const jobMonthsByJob = new Map<string, DemoJobMonth[]>()
for (const row of demoJobMonths) { const list = jobMonthsByJob.get(row.job_number) ?? []; list.push(row); jobMonthsByJob.set(row.job_number, list) }

/**
 * Demo `key_accounts` setting (contract "Reporting scope: key accounts first"). Ordered the way
 * the long tail is not: these five carry most of the seeded revenue, and three of them have
 * sub-accounts, so the sub-account select has something to show.
 */
export const DEMO_KEY_ACCOUNTS: { name: string; label: string }[] = [
  { name: 'Apex Commerce', label: 'Apex Commerce (incl. APD, APF)' },
  { name: 'Harbor Properties', label: 'Harbor Properties (office funds)' },
  { name: 'Meridian Health', label: 'Meridian Health' },
  { name: 'Summit Education', label: 'Summit Education (school districts)' },
  { name: 'Beacon Financial', label: 'Beacon Financial' },
]
const DEMO_KEY_ACCOUNT_NAMES = new Set(DEMO_KEY_ACCOUNTS.map((a) => a.name))
export const demoIsKeyAccount = (meta: DemoJobMeta): boolean => DEMO_KEY_ACCOUNT_NAMES.has(meta.site.customer)

/** `scope` is ignored when an account is selected; without one the server default is `key`. */
const scopeModeOf = (query?: ReportingQuery): ScopeMode => (query?.scope && ['key', 'all', 'other'].includes(query.scope) ? query.scope : 'key')

/** Contract rule: the scope default is `key`, so an omitted query is key-scoped like the server. */
function matchesFilters(meta: DemoJobMeta, query?: ReportingQuery): boolean {
  const site = meta.site
  if (query?.account) {
    if (site.customer !== query.account) return false
    if (query.sub_account && demoSubAccountOf(meta) !== query.sub_account) return false
  } else {
    const mode = scopeModeOf(query)
    if (mode === 'key' && !demoIsKeyAccount(meta)) return false
    if (mode === 'other' && demoIsKeyAccount(meta)) return false
  }
  if (query?.delivery && demoDeliveryModelOf(meta) !== query.delivery) return false
  if (query?.region && site.region !== query.region) return false
  if (query?.branch && site.branch !== query.branch) return false
  if (query?.service_type && site.serviceType !== query.service_type) return false
  if (query?.vertical && meta.vertical !== query.vertical) return false
  if (query?.company && demoCompanyOf(meta) !== query.company) return false
  if (query?.job_number && meta.job_number !== query.job_number) return false
  return true
}

/** `range.scope`: what the payload covers, so a view can state it in one line. */
function scopeBlock(query: ReportingQuery | undefined, metas: DemoJobMeta[]): ScopeBlock {
  const accounts = [...new Set(metas.map((meta) => meta.site.customer))].sort()
  const sites = metas.length
  if (query?.account) return { mode: 'account', label: query.sub_account ? `${query.account} · ${query.sub_account}` : query.account, accounts, sites }
  const mode = scopeModeOf(query)
  return { mode, label: mode === 'all' ? 'All accounts' : mode === 'other' ? 'Other accounts' : 'Key accounts', accounts, sites }
}

function scope(query?: ReportingQuery) {
  const period: Period = query?.period ?? 'YTD'
  const anchor = query?.month ?? DEMO_LATEST_MONTH
  const metas = demoJobMeta.filter((meta) => matchesFilters(meta, query))
  const range: RangeBlock = { ...resolveRange(period, anchor), scope: scopeBlock(query, metas) }
  return { period, anchor, range, metas }
}

/** Closed rows plus the in-progress month when the range reaches it (selectable, flagged in /dimensions). */
const rowsForMonth = (meta: DemoJobMeta, month: IsoMonth): DemoJobMonth[] => month === DEMO_PACE_MONTH ? demoPartialMonth.filter((r) => r.job_number === meta.job_number) : (jobMonthsByJob.get(meta.job_number) ?? []).filter((r) => r.month === month)
const rowsIn = (meta: DemoJobMeta, range: RangeBlock) => [...(jobMonthsByJob.get(meta.job_number) ?? []).filter((row) => row.month >= range.from && row.month <= range.to), ...(range.to >= DEMO_PACE_MONTH && range.from <= DEMO_PACE_MONTH ? rowsForMonth(meta, DEMO_PACE_MONTH) : [])]

interface Totals { revenue: number; invoiced: number; collected: number; budget_revenue: number | null; labor: number; burden: number; budget_labor: number | null; gp: number; hours: number; regular: number; ot: number; scheduled: number; employees: number; months: number }

function totals(rows: DemoJobMonth[]): Totals {
  const anyBudget = rows.some((r) => r.budget_labor !== null)
  return {
    revenue: sum(rows, (r) => r.revenue), invoiced: sum(rows, (r) => r.invoiced_total), collected: sum(rows, (r) => r.collected_total),
    budget_revenue: anyBudget ? sum(rows, (r) => r.budget_revenue) : null,
    labor: sum(rows, (r) => r.labor_cost), burden: sum(rows, (r) => r.burden_cost), budget_labor: anyBudget ? sum(rows, (r) => r.budget_labor) : null,
    gp: sum(rows, (r) => r.gross_profit), hours: sum(rows, (r) => r.hours), regular: sum(rows, (r) => r.regular_hours), ot: sum(rows, (r) => r.overtime_hours),
    scheduled: sum(rows, (r) => r.scheduled_hours), employees: rows.length ? Math.max(...rows.map((r) => r.employee_count)) : 0, months: rows.filter((r) => r.revenue > 0).length,
  }
}

function statusFor(t: Totals, arDays: number | null): { status: JobStatus; reasons: string[] } {
  const th = thresholds()
  const reasons: string[] = []
  let level = 0
  const margin = t.revenue ? (t.gp / t.revenue) * 100 : null
  const laborOver = t.budget_labor ? ((t.labor - t.budget_labor) / t.budget_labor) * 100 : null
  const otPct = t.hours ? (t.ot / t.hours) * 100 : 0
  const push = (severity: number, text: string) => { level = Math.max(level, severity); reasons.push(text) }
  if (margin !== null && margin < th.marginTarget - th.marginCriticalDelta) push(2, `Gross margin ${round1(margin)}% is more than ${th.marginCriticalDelta} pts below the ${th.marginTarget}% target`)
  else if (margin !== null && margin < th.marginTarget) push(1, `Gross margin ${round1(margin)}% is below the ${th.marginTarget}% target`)
  if (laborOver !== null && laborOver > th.laborCritical) push(2, `Labor ${round1(laborOver)}% over budget`)
  else if (laborOver !== null && laborOver > th.laborWatch) push(1, `Labor ${round1(laborOver)}% over budget`)
  if (otPct > th.otCritical) push(2, `Overtime ${round1(otPct)}% of hours`)
  else if (otPct > th.otWatch) push(1, `Overtime ${round1(otPct)}% of hours`)
  if (arDays !== null && arDays > th.arCritical) push(2, `Weighted AR ${Math.round(arDays)} days`)
  else if (arDays !== null && arDays > th.arWatch) push(1, `Weighted AR ${Math.round(arDays)} days`)
  return { status: level === 2 ? 'Critical' : level === 1 ? 'Watch' : 'Healthy', reasons }
}

function jobRow(meta: DemoJobMeta, range: RangeBlock): JobRow {
  const site = meta.site
  const rows = rowsIn(meta, range)
  const t = totals(rows)
  const active = !meta.endMonth
  const arOpen = active ? site.openReceivables : 0
  const arDays = arOpen ? site.daysOutstanding : null
  const { status, reasons } = statusFor(t, arDays)
  return {
    job_key: meta.job_key, job_number: meta.job_number, job_name: site.name, parent_account: site.customer, customer_number: meta.customer_number,
    region: site.region, branch: site.branch, service_type: site.serviceType, vertical: meta.vertical, manager_name: site.siteManager,
    city: site.city, state_province: site.state, country_code: site.country === 'Canada' ? 'CA' : 'US', latitude: site.latitude, longitude: site.longitude,
    is_active: active, date_to_start: meta.startMonth ?? site.contractStart,
    revenue: t.revenue, invoiced_total: t.invoiced, collected_total: t.collected, gross_profit: t.gp, gross_margin_pct: pct(t.gp, t.revenue),
    labor_cost: t.labor, burden_cost: t.burden, hours: t.hours, regular_hours: t.regular, overtime_hours: t.ot, scheduled_hours: t.scheduled,
    budget_revenue: t.budget_revenue, budget_labor: t.budget_labor, labor_variance: t.budget_labor === null ? null : t.labor - t.budget_labor, hours_variance: t.hours - t.scheduled,
    employee_count: t.employees, ar_open: arOpen, days_outstanding_weighted: arDays, last_invoice_date: active ? site.lastInvoiceDate : `${meta.endMonth?.slice(0, 7)}-28`,
    last_work_date: active ? DEMO_PACE_AS_OF : `${meta.endMonth?.slice(0, 7)}-31`, months_reporting: t.months, status, status_reasons: reasons,
    company: demoCompanyOf(meta), delivery_model: demoDeliveryModelOf(meta), geo_precision: demoGeoPrecisionOf(meta),
    ...(({ direct_cost: _direct, ...parts }) => parts)(breakdownOf(t.labor, t.burden, demoDeliveryModelOf(meta))),
    is_collectible_ar_only: false,
  }
}

const groupTotals = (rows: JobRow[], key: (row: JobRow) => string): GroupTotals[] => {
  const map = new Map<string, GroupTotals>()
  for (const row of rows) {
    const name = key(row)
    const entry = map.get(name) ?? { name, revenue: 0, gross_profit: 0, labor_cost: 0, hours: 0, jobs: 0 }
    entry.revenue += row.revenue; entry.gross_profit += row.gross_profit; entry.labor_cost += row.labor_cost; entry.hours += row.hours; entry.jobs += 1
    map.set(name, entry)
  }
  return [...map.values()].sort((a, b) => b.revenue - a.revenue)
}

const monthlyRows = (metas: DemoJobMeta[], months: IsoMonth[]) => months.map((month) => {
  const rows = metas.flatMap((meta) => rowsForMonth(meta, month))
  return { month, rows, t: totals(rows) }
})

const apFor = (range: RangeBlock, shareOfPortfolio: number) => demoApMonths.filter((r) => r.month >= range.from && r.month <= range.to).map((r) => ({ ...r, invoiced: Math.round(r.invoiced * shareOfPortfolio), paid: Math.round(r.paid * shareOfPortfolio) }))

const dsoFor = (metas: DemoJobMeta[], anchor: IsoMonth, arOpen: number) => {
  const trailing = { from: addMonths(anchor, -2), to: anchor, months: 3 }
  const revenue = sum(metas.flatMap((meta) => rowsIn(meta, trailing)), (r) => r.revenue)
  return revenue ? round1(arOpen / (revenue / 91)) : null
}

const bucketOf = (days: number): AgingBucketKey => (days < 31 ? 'current' : days < 61 ? 'd30' : days < 91 ? 'd60' : days < 121 ? 'd90' : 'd90_plus')
const bucketLabels: Record<AgingBucketKey, string> = { current: '0-30', d30: '31-60', d60: '61-90', d90: '91-120', d90_plus: '120+' }

const openInvoices = (): ArInvoiceRow[] => demoInvoices.filter((inv) => !demoJobMeta.find((m) => m.job_number === inv.job_number)?.endMonth).map((inv) => ({ ...inv, aging_bucket: bucketOf(inv.days_outstanding) }))

// ------------------------------------------------------------------ Forecast

const FORECAST_METRICS: ForecastMetric[] = ['revenue', 'gross_profit', 'labor_cost', 'subcontract_cost']
const metaByJob = new Map(demoJobMeta.map((meta) => [meta.job_number, meta]))
/** Subcontract cost comes from the same burden split the reference-source cost breakdown uses, so the metric reconciles with Cost analysis. */
const subcontractCostOf = (row: DemoJobMonth) => { const meta = metaByJob.get(row.job_number); return meta ? breakdownOf(row.labor_cost, row.burden_cost, demoDeliveryModelOf(meta)).subcontract_cost : 0 }
const metricValue = (row: DemoJobMonth, metric: ForecastMetric) => metric === 'revenue' ? row.revenue : metric === 'gross_profit' ? row.gross_profit : metric === 'labor_cost' ? row.labor_cost : subcontractCostOf(row)
const methodFor = (index: number) => (['naive', 'recent_median', 'damped_theil_sen'] as const)[index % 3]

function seriesStatus(meta: DemoJobMeta, metric: ForecastMetric = 'revenue'): { ok: boolean; reason: string; last: IsoMonth | null; n: number } {
  const rows = jobMonthsByJob.get(meta.job_number) ?? []
  const last = rows.at(-1)?.month ?? null
  if (rows.length < 12) return { ok: false, reason: `insufficient_history: ${rows.length} valid months, 12 required`, last, n: rows.length }
  if (last !== DEMO_LATEST_MONTH) return { ok: false, reason: `stale_series: no activity since ${last}`, last, n: rows.length }
  // subcontract_cost series are gated on subcontract cost > 0 in a closed month.
  if (metric === 'subcontract_cost' && !rows.some((r) => subcontractCostOf(r) > 0)) return { ok: false, reason: 'no_subcontract_cost: no closed month with subcontract cost > 0', last, n: 0 }
  return { ok: true, reason: '', last, n: rows.length }
}
const forecastMetricsFor = (meta: DemoJobMeta) => FORECAST_METRICS.filter((metric) => seriesStatus(meta, metric).ok)
const seriesStatusRow = (meta: DemoJobMeta, metric: ForecastMetric, status: ReturnType<typeof seriesStatus>): SeriesStatus => ({ job_number: meta.job_number, job_name: meta.site.name, metric, status: status.reason.split(':')[0], reason: status.reason, last_valid_month: status.last, n_valid: status.n, delivery_model: demoDeliveryModelOf(meta) })

function siteForecast(meta: DemoJobMeta, metric: ForecastMetric): ForecastRow[] {
  const rows = jobMonthsByJob.get(meta.job_number) ?? []
  const values = rows.map((r) => metricValue(r, metric))
  const last12 = values.slice(-12), last6 = values.slice(-6)
  const level = median(last6)
  const mean = last12.reduce((a, b) => a + b, 0) / last12.length
  const cv = Math.sqrt(last12.reduce((s, v) => s + (v - mean) ** 2, 0) / last12.length) / Math.max(1, mean)
  const volatility = cv < 0.035 ? 'low' : cv < 0.07 ? 'medium' : 'high'
  const method = methodFor(meta.index + FORECAST_METRICS.indexOf(metric))
  const slope = method === 'damped_theil_sen' ? Math.max(-0.02, Math.min(0.02, (median(values.slice(-6)) - median(values.slice(-12, -6))) / 6 / Math.max(1, level))) : 0
  const rng = mulberry32(meta.index * 53 + FORECAST_METRICS.indexOf(metric) * 7)
  const nBacktests = meta.index % 9 === 4 ? 2 : 6
  const accuracy: ForecastAccuracy = { n_backtests: nBacktests, median_ape: round1(cv * 80 + rng() * 2), mase: round1(0.72 + rng() * 0.4), coverage: round1(76 + rng() * 10) / 100 }
  const excluded = meta.index % 5 === 2 ? [{ month: '2025-12-01', reason: 'anomaly: holiday billing spike (MAD > 3.5)' }] : []
  const base = method === 'naive' ? values.at(-1)! : level
  return [1, 2, 3].map((h) => {
    let point = base
    for (let step = 1; step <= h; step++) point *= 1 + slope * 0.9 ** step
    point = Math.round(point)
    const width = point * (Math.max(0.03, cv * 1.28) * Math.sqrt(h))
    return {
      job_number: meta.job_number, job_name: meta.site.name, metric, basis_month: DEMO_LATEST_MONTH, forecast_month: addMonths(DEMO_LATEST_MONTH, h), horizon_step: h,
      point, lo: Math.round(point - width), hi: Math.round(point + width), method,
      explanation: method === 'naive' ? `Last closed month carried forward; walk-forward backtest found no meaningful improvement from level or trend candidates.` : method === 'recent_median' ? `Median of the last 6 closed months; robust to a single-month spike. Selected by one-step walk-forward backtest.` : `Damped Theil-Sen trend on the last 12 closed months (slope ${(slope * 100).toFixed(2)}%/month, damping 0.9). Selected by walk-forward backtest with a meaningful-improvement threshold.`,
      n_history: values.length, status: 'forecast', volatility_class: volatility,
      input_months: rows.slice(-12).map((r) => r.month), excluded_months: excluded,
      method_selection: { candidates: ['naive', 'recent_median', 'damped_theil_sen'], selected: method, improvement_threshold: 0.05 },
      interval: { level: 0.8, source: nBacktests >= 3 ? 'empirical_walk_forward' : `pooled_${volatility}_volatility_class`, horizon_scaling: 'sqrt(h)' },
      disruption: meta.index % 11 === 6 ? { flag: 'manager_change', month: '2026-06-01', handling: 'included; recent-weighted' } : null,
      identity: null, quality: { cv_12m: round1(cv * 100) / 100, months_excluded: excluded.length },
      engine_version: 'v2.0.0-demo', accuracy,
      delivery_model: demoDeliveryModelOf(meta), parent_account: meta.site.customer,
    }
  })
}

const runMeta: RunMeta = {
  run_id: 'demo-run-2026-09-01', engine_version: 'v2.0.0-demo', generated_at: '2026-09-01T05:48:00Z', latest_closed_month: DEMO_LATEST_MONTH, horizon_months: 3,
  dataset: { jobs_total: demoJobMeta.length, jobs_forecast: demoJobMeta.filter((m) => seriesStatus(m).ok).length, months_available: demoMonths.length, basis: 'mart.job_month (demo)' },
  gates: { min_history_months: 12, stale_after_months: 2, anomaly_rule: 'MAD > 3.5 on log revenue', partial_month_excluded: true },
  coverage: { target: 0.8, measured_80: 0.81, n_evaluated: 108, origins: '2026-02 to 2026-07' },
  disruption: { sites_flagged: 2, policy: 'flag; include with recent weighting; never silently drop' },
  portfolio: { method: 'sum_of_site_points', band_policy: 'sum of site bands (conservative)' },
  assumptions: [
    'Revenue basis is AR invoice revenueTotal attributed to service month; August 2026 is the latest closed month.',
    'A site needs 12 valid closed months and activity in the latest closed month to be forecast; others are listed as not forecast with a reason.',
    'Candidate methods are naive, recent median level and damped Theil-Sen trend; one-step walk-forward backtest selects a candidate only when it beats naive by at least 5%.',
    '80% bands come from empirical horizon-specific walk-forward errors when at least 3 backtests exist; otherwise from the reviewed volatility-class pool.',
    'The partial September 2026 month is excluded from fitting and shown as partial in history.',
    'Portfolio forecast is the sum of site points; bands are summed, which overstates portfolio uncertainty.',
  ],
}

function trackRecord(metas: DemoJobMeta[], metric: ForecastMetric, jobNumber: string): TrackRecordRow[] {
  const origins = listMonths('2026-02-01', '2026-07-01')
  const rows: TrackRecordRow[] = []
  const monthly = monthlyRows(metas, demoMonths)
  const valueAt = (month: IsoMonth) => { const m = monthly.find((r) => r.month === month); return m ? sum(m.rows, (r) => metricValue(r, metric)) : null }
  const seed = jobNumber === '__ALL__' ? 1 : (demoJobMeta.find((m) => m.job_number === jobNumber)?.index ?? 0) + 11
  origins.forEach((origin, o) => {
    const base = valueAt(origin)
    if (!base) return
    for (let h = 1; h <= 3; h++) {
      const forecastMonth = addMonths(origin, h)
      if (forecastMonth > DEMO_LATEST_MONTH) continue
      const rng = mulberry32(seed * 97 + o * 13 + h)
      const point = Math.round(base * (1 + (rng() - 0.5) * 0.03))
      const width = point * 0.045 * Math.sqrt(h)
      const actual = valueAt(forecastMonth)
      const inBand = actual === null ? null : actual >= point - width && actual <= point + width
      rows.push({ origin_month: origin, forecast_month: forecastMonth, horizon: h, method: methodFor(o + h), point, lo: Math.round(point - width), hi: Math.round(point + width), actual, scaled_error: actual === null ? null : round1(Math.abs(actual - point) / Math.max(1, width) * 100) / 100, in_band: inBand })
    }
  })
  return rows
}

function historyRows(metas: DemoJobMeta[]): ForecastHistoryRow[] {
  const closed = monthlyRows(metas, demoMonths).map(({ month, rows, t }) => ({ month, revenue: t.revenue, gross_profit: t.gp, labor_cost: t.labor, subcontract_cost: sum(rows, subcontractCostOf), hours: t.hours, closed: true, suspect: month === '2026-02-01' ? 'billing_timing: late invoices shifted revenue into March' : null }))
  const partialRows = demoPartialMonth.filter((r) => metas.some((m) => m.job_number === r.job_number))
  const partial = totals(partialRows)
  return [...closed, { month: DEMO_PACE_MONTH, revenue: partial.revenue, gross_profit: partial.gp, labor_cost: partial.labor, subcontract_cost: sum(partialRows, subcontractCostOf), hours: partial.hours, closed: false, suspect: 'partial_month: through 2026-09-14' }]
}

// ------------------------------------------------------- Executive labor P&L

/** Demo business units (contract: BU = company; targets from setting `bu_targets`). Colours match the executive dashboard. */
export const DEMO_BUSINESS_UNITS: ExecutiveBusinessUnit[] = [
  { key: 'crane_west', name: 'Crane West', color: '#378ADD', target_pct: 59.5, high_pct: 65 },
  { key: 'crane_ifs', name: 'Crane IFS', color: '#1D9E75', target_pct: 64.5, high_pct: 70 },
  { key: 'crane_southwest', name: 'Crane Southwest', color: '#D97706', target_pct: 64.5, high_pct: 70 },
  { key: 'sarus', name: 'Sarus', color: '#D85A30', target_pct: 64.5, high_pct: 70 },
]
/** Seeded sites are grouped into BUs by geography: Canada -> Sarus, Southwest / Dallas branches -> Crane Southwest, West region -> Crane West, everything else -> Crane IFS. */
export const demoBusinessUnitOf = (meta: DemoJobMeta): string => (meta.site.country === 'Canada' ? 'Sarus' : meta.site.branch === 'Southwest' || meta.site.branch === 'Dallas–Fort Worth' ? 'Crane Southwest' : meta.site.region === 'West' ? 'Crane West' : 'Crane IFS')
/** Short site code the executive tables use ("chi-01" -> "CHI1"). */
export const demoSiteCodeOf = (meta: DemoJobMeta): string => meta.seedId.toUpperCase().replace(/-0?/, '')
/**
 * Demo `sub_account_rules` (contract "Executive slicing"): the second level under a key account.
 * Summit Education splits into school districts, Apex Commerce into its distribution / fulfillment
 * divisions (the FedEx Express / Ground shape), Harbor Properties into office funds (Fund I is fully
 * subcontracted). Every other account's sub-account is the account itself.
 */
export const DEMO_SUB_ACCOUNT_RULES: Record<string, Record<string, string>> = {
  'Summit Education': { 'den-01': 'Front Range Unified School District', 'stl-01': 'Gateway Public School District' },
  'Apex Commerce': { 'chi-01': 'Apex Distribution (APD)', 'sea-01': 'Apex Fulfillment (APF)', 'phx-01': 'Apex Fulfillment (APF)' },
  'Harbor Properties': { 'nyc-01': 'Harbor Office Fund I', 'dc-01': 'Harbor Office Fund I', 'msp-01': 'Harbor Office Fund II', 'tor-01': 'Harbor Office Fund II' },
}
export const demoSubAccountOf = (meta: DemoJobMeta): string => DEMO_SUB_ACCOUNT_RULES[meta.site.customer]?.[meta.seedId] ?? meta.site.customer
/** Latest Monday with any labor in the demo (the in-progress month runs through DEMO_PACE_AS_OF = Sep 14, a Monday). */
export const DEMO_EXEC_LAST_WEEK = '2026-09-14'
/** Latest week with a full 7 days of labor. */
export const DEMO_EXEC_SELECTED_WEEK = '2026-09-07'
const DEMO_PACE_DAYS = 14

const isoDay = (date: Date) => date.toISOString().slice(0, 10)
const addDays = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return isoDay(d) }
export const demoExecWeeks = (count: number, last = DEMO_EXEC_LAST_WEEK): string[] => Array.from({ length: count }, (_, i) => addDays(last, -7 * (count - 1 - i)))

/**
 * Daily share of a site's month row. Actuals: closed months by calendar days, the in-progress month by its
 * elapsed days (its partial row holds month-to-date values; no labor after the as-of date). Budgets are
 * whole-month figures in both cases, so their share is always 1 / days in the month.
 */
function demoDailyShare(meta: DemoJobMeta, day: string): { row: DemoJobMonth; share: number; budgetShare: number; closed: boolean } | null {
  const month = `${day.slice(0, 7)}-01`
  const budgetShare = 1 / daysInMonth(month)
  if (month === DEMO_PACE_MONTH) {
    const row = demoPartialMonth.find((r) => r.job_number === meta.job_number)
    if (!row || Number(day.slice(8, 10)) > DEMO_PACE_DAYS) return null
    return { row, share: 1 / DEMO_PACE_DAYS, budgetShare, closed: false }
  }
  const row = (jobMonthsByJob.get(meta.job_number) ?? []).find((r) => r.month === month)
  return row ? { row, share: budgetShare, budgetShare, closed: true } : null
}

/**
 * The July 2026 close anomaly the executives flagged: the Crane IFS subcontracted sites carry a duplicate subcontract
 * posting in that month's job cost, so their cost exceeds invoicing several times over and the BU's cost % blows past
 * the axis. The demo reproduces it (flagged multiple of the vendor line for July days) so the charts' clamped axis and
 * anomaly markers can be seen; the real fix is in WinTeam, not here.
 */
export const DEMO_ANOMALY_MONTH = '2026-07-01'
export const DEMO_ANOMALY_MULTIPLE = 10
export const demoIsAnomalySite = (meta: DemoJobMeta) => demoDeliveryModelOf(meta) === 'subcontracted' && demoBusinessUnitOf(meta) === 'Crane IFS'

function demoExecRow(meta: DemoJobMeta, week: string): ExecutiveLaborRow | null {
  const days = Array.from({ length: 7 }, (_, i) => { const iso = addDays(week, i); const d = demoDailyShare(meta, iso); return d ? { ...d, iso } : null }).filter((d): d is NonNullable<typeof d> => d !== null)
  if (!days.length) return null
  const part = (pick: (r: DemoJobMonth) => number | null) => days.reduce((t, d) => t + (pick(d.row) ?? 0) * d.share, 0)
  const budgetPart = (pick: (r: DemoJobMonth) => number | null) => days.reduce((t, d) => t + (pick(d.row) ?? 0) * d.budgetShare, 0)
  const model = demoDeliveryModelOf(meta)
  const closed = days.every((d) => d.closed)
  const hoursBase = part((r) => r.hours), laborBase = part((r) => r.labor_cost)
  const rate = hoursBase ? laborBase / hoursBase : 0
  // Week number since the epoch keeps a week's values stable whatever `weeks` window is requested.
  const wk = Math.round(Date.parse(`${week}T00:00:00Z`) / 604_800_000)
  const rng = mulberry32(meta.index * 7919 + wk * 131 + 3)
  const common = mulberry32(wk * 17 + 5)
  // A portfolio-wide weekly swing (staffing waves, holidays) on top of per-site noise so the BU trends move like real weeks do.
  const weekWave = 1 + 0.06 * Math.sin(wk * 1.1) + (common() - 0.5) * 0.05
  const otWave = 1 + 0.35 * Math.sin(wk * 0.7 + 1) + (common() - 0.5) * 0.3
  const subcontracted = model === 'subcontracted'
  // Contract row semantics: hours / direct / OT are self-performed labor (0 for subcontracted sites); a
  // subcontracted site's seeded labor line is what the vendor invoices, so it lands in sub_dollars.
  const hours = subcontracted ? 0 : hoursBase * weekWave * (1 + (rng() - 0.5) * 0.12)
  const otHours = subcontracted ? 0 : part((r) => r.overtime_hours) * Math.max(0.2, otWave) * (1 + (rng() - 0.5) * 0.6)
  const dtHours = meta.index % 4 === 1 ? otHours * 0.1 : 0
  const direct = hours * rate
  const otDollars = otHours * rate * 0.5 + dtHours * rate
  const vendorLabor = subcontracted ? laborBase * weekWave * (1 + (rng() - 0.5) * 0.08) : 0
  const anomalyDays = demoIsAnomalySite(meta) ? days.filter((d) => d.iso.startsWith(DEMO_ANOMALY_MONTH.slice(0, 7))).length : 0
  const flagged = anomalyDays ? (vendorLabor * DEMO_ANOMALY_MULTIPLE * anomalyDays) / days.length : 0
  const sub = vendorLabor + flagged + days.reduce((t, d) => t + breakdownOf(d.row.labor_cost, d.row.burden_cost, model).subcontract_cost * d.share, 0)
  const hasBudget = days.some((d) => d.row.budget_labor !== null)
  const invoicing = closed ? part((r) => r.revenue) : part((r) => r.invoiced_total)
  const r2 = (v: number) => Math.round(v * 100) / 100
  return {
    week, bu: demoBusinessUnitOf(meta), site: demoSiteCodeOf(meta), job_number: meta.job_number, site_name: meta.site.name, account: meta.site.customer, sub_account: demoSubAccountOf(meta), delivery_model: model,
    invoicing: r2(invoicing), invoicing_basis: invoicing <= 0 ? 'none' : closed ? 'job_cost_month_prorated' : 'ar_invoice_prorated',
    hours: r2(hours), ot_hours: r2(otHours), dt_hours: r2(dtHours),
    // Seed partial rows scale scheduled_hours month-to-date but keep budget_labor whole-month. A subcontracted site budgets dollars, not hours.
    budget_hours: hasBudget && !subcontracted ? r2(part((r) => r.scheduled_hours)) : 0, budget_dollars: hasBudget ? r2(budgetPart((r) => r.budget_labor)) : 0, budget_basis: hasBudget ? (meta.index % 2 ? 'hbc' : 'daily_budget') : 'none',
    direct_dollars: r2(direct), ot_dollars: r2(otDollars), sub_dollars: r2(sub), sub_estimated: sub > 0 && !closed, total_dollars: r2(direct + otDollars + sub),
    sub_basis: sub <= 0 ? 'none' : closed ? 'job_cost_month_prorated' : 'trailing_3mo_projection',
    labor_cost_basis: closed ? 'job_cost' : 'trailing_job_rate', days_with_labor: days.length,
  }
}

export function demoExecutiveLaborPl(query: ExecutiveLaborPlQuery = {}): ExecutiveLaborPl {
  const account = query.account && query.account !== 'All' ? query.account : 'All'
  const subAccount = account !== 'All' && query.sub_account ? query.sub_account : null
  const delivery = query.delivery ?? 'all'
  const weeks = demoExecWeeks(Math.min(52, Math.max(4, query.weeks ?? 18)))
  const metas = demoJobMeta.filter((meta) => (account === 'All' || meta.site.customer === account) && (!subAccount || demoSubAccountOf(meta) === subAccount) && (delivery === 'all' || demoDeliveryModelOf(meta) === delivery))
  const rows = weeks.flatMap((week) => metas.map((meta) => demoExecRow(meta, week)).filter((r): r is ExecutiveLaborRow => r !== null))
  const present = new Set(rows.map((r) => r.bu))
  const selected = query.week && weeks.includes(query.week) ? query.week : DEMO_EXEC_SELECTED_WEEK
  const selectedWeek = weeks.includes(selected) ? selected : weeks.at(-1) ?? null
  const selectedRows = rows.filter((r) => r.week === selectedWeek)
  const selfCount = selectedRows.filter((r) => r.delivery_model !== 'subcontracted').length, subCount = selectedRows.length - selfCount
  return {
    source: { ...source, synced_at: DEMO_AS_OF }, as_of: DEMO_PACE_AS_OF, account, sub_account: subAccount, delivery, weeks, selected_week: selectedWeek,
    business_units: DEMO_BUSINESS_UNITS.filter((bu) => present.has(bu.name)), rows, qa: null,
    vendor: demoExecutiveVendor(metas),
    notes: [
      `Selected week delivery split: ${selfCount} self-performed sites (hours and labor dollars), ${subCount} subcontracted sites (vendor cost, no hours).`,
      'Invoicing = closed-month job-cost revenue apportioned to weeks by calendar days; the in-progress month uses AR invoices for the service month apportioned the same way (invoicing_basis says which).',
      'Direct labor = hours × the job rate. OT cost = OT hours × rate × 0.5 premium + DT hours × rate (estimate).',
      'Vendor cost = the site\'s monthly subcontract cost apportioned by calendar days; ~ marks weeks in a month that is not closed (latest closed month\'s rate carried forward).',
      'Budget = the monthly labor budget and scheduled hours apportioned by calendar days (the demo has no daily budgets).',
      'AP subcontractor invoicing is company-wide (WinTeam AP is not job-linked), so the vendor card compares an account\'s job-cost subcontract line with the whole company\'s AP.',
      'Demo data: seeded sites grouped into business units by geography; none of it is customer data. July 2026 carries a flagged duplicate subcontract posting on the Crane IFS subcontracted sites (the anomaly the charts annotate).',
    ],
  }
}

/** Demo vendor types: two subcontractor-type vendors match the default `subcontractor_vendor_types`; the rest are supplies / equipment. */
export const DEMO_VENDOR_TYPE: Record<string, string> = { 'V-2001': 'Supplies', 'V-2002': 'Subcontract', 'V-2003': 'Janitorial', 'V-2004': 'Supplies', 'V-2005': 'Equipment', 'V-2006': 'Services', 'V-2007': 'Services', 'V-2008': 'Uniforms' }
const DEMO_SUB_VENDOR_TYPES = ['subcontract', 'sub contract', 'janitorial', 'labor', 'staffing', 'agency']
const isSubVendor = (vendorNumber: string) => { const t = (DEMO_VENDOR_TYPE[vendorNumber] ?? '').toLowerCase(); return DEMO_SUB_VENDOR_TYPES.some((x) => t.includes(x)) }

/** A site's job-cost subcontract line for a closed month (vendor line of a subcontracted site + the burden share), incl. the July anomaly. */
function demoMonthSub(meta: DemoJobMeta, row: DemoJobMonth): number {
  const model = demoDeliveryModelOf(meta)
  const vendorLine = model === 'subcontracted' ? row.labor_cost : 0
  const flagged = row.month === DEMO_ANOMALY_MONTH && demoIsAnomalySite(meta) ? vendorLine * DEMO_ANOMALY_MULTIPLE : 0
  return vendorLine + flagged + breakdownOf(row.labor_cost, row.burden_cost, model).subcontract_cost
}

/**
 * Contract "Vendor cost: projection and live AP look": the last 6 closed months of job-cost subcontract vs AP
 * subcontractor invoicing (company-wide), the in-progress month's projection (trailing 3 closed months' weekly
 * average × the month's weeks) and the month-to-date AP look.
 */
export function demoExecutiveVendor(metas: DemoJobMeta[]): ExecutiveVendorBlock {
  const closed = demoMonths.slice(-6)
  const subFor = (month: string) => metas.reduce((t, meta) => t + (jobMonthsByJob.get(meta.job_number) ?? []).filter((r) => r.month === month).reduce((u, r) => u + demoMonthSub(meta, r), 0), 0)
  const apFor = (month: string, subOnly: boolean) => demoApMonths.filter((r) => r.month === month && (!subOnly || isSubVendor(r.vendor_number)))
  const history = closed.map((month) => ({ month, job_cost_sub: Math.round(subFor(month)), ap_subcontractor_invoiced: Math.round(apFor(month, true).reduce((t, r) => t + r.invoiced, 0)), ap_all_invoiced: Math.round(apFor(month, false).reduce((t, r) => t + r.invoiced, 0)) }))
  const trailing = demoMonths.slice(-3)
  const trailingDays = trailing.reduce((t, m) => t + daysInMonth(m), 0)
  const projectedSites = metas.filter((meta) => trailing.some((m) => (jobMonthsByJob.get(meta.job_number) ?? []).some((r) => r.month === m && demoMonthSub(meta, r) > 0)))
  const weeklyAverage = (trailing.reduce((t, m) => t + subFor(m), 0) / trailingDays) * 7
  const projected = Math.round((weeklyAverage * daysInMonth(DEMO_PACE_MONTH)) / 7)
  // AP for the in-progress month: the subcontractor-type vendors' August run rate, elapsed-days share.
  const lastAp = apFor(demoMonths[demoMonths.length - 1], true)
  const elapsed = DEMO_PACE_DAYS / daysInMonth(DEMO_PACE_MONTH)
  const byType = [...new Set(lastAp.map((r) => DEMO_VENDOR_TYPE[r.vendor_number] ?? 'Subcontract'))].map((vendor_type) => {
    const list = lastAp.filter((r) => (DEMO_VENDOR_TYPE[r.vendor_number] ?? 'Subcontract') === vendor_type)
    return { vendor_type, invoiced: Math.round(list.reduce((t, r) => t + r.invoiced, 0) * elapsed), invoices: Math.max(1, Math.round(list.reduce((t, r) => t + r.invoices, 0) * elapsed)) }
  })
  return {
    month: DEMO_PACE_MONTH, month_status: 'in_progress', as_of: DEMO_PACE_AS_OF,
    projected_month_sub: projected, projected_basis: 'trailing_3mo_projection', sites_projected: projectedSites.length,
    ap_live: { invoiced_to_date: byType.reduce((t, x) => t + x.invoiced, 0), invoices: byType.reduce((t, x) => t + x.invoices, 0), vendors: lastAp.length, through: DEMO_PACE_AS_OF, by_vendor_type: byType },
    history,
  }
}

const demoDeliveryCounts = (metas: DemoJobMeta[]) => ({ self_perform: metas.filter((m) => demoDeliveryModelOf(m) === 'self_perform').length, subcontracted: metas.filter((m) => demoDeliveryModelOf(m) === 'subcontracted').length })

/** `/dimensions.key_accounts`: label, site count and the sub-accounts under each key account. */
export function demoKeyAccountDimensions(): KeyAccountDimension[] {
  return DEMO_KEY_ACCOUNTS.map(({ name, label }) => {
    const metas = demoJobMeta.filter((meta) => meta.site.customer === name)
    const subs = [...new Set(metas.map(demoSubAccountOf))]
      .map((sub) => ({ name: sub, sites: metas.filter((m) => demoSubAccountOf(m) === sub).length }))
      .sort((a, b) => b.sites - a.sites || a.name.localeCompare(b.name))
    return { name, label, sites: metas.length, sub_accounts: subs }
  })
}

/** `/dimensions.other_accounts`: the long tail, ordered by revenue desc for the latest closed month. */
export function demoOtherAccountDimensions(): OtherAccountDimension[] {
  const names = [...new Set(demoJobMeta.filter((meta) => !demoIsKeyAccount(meta)).map((meta) => meta.site.customer))]
  const revenueOf = (name: string) => sum(demoJobMeta.filter((meta) => meta.site.customer === name).flatMap((meta) => rowsForMonth(meta, DEMO_LATEST_MONTH)), (r) => r.revenue)
  return names.map((name) => ({ name, sites: demoJobMeta.filter((meta) => meta.site.customer === name).length, revenue: revenueOf(name) }))
    .sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name))
    .map(({ name, sites }) => ({ name, sites }))
}

export function demoExecutiveAccounts(): ExecutiveAccount[] {
  const names = [...new Set(demoJobMeta.map((meta) => meta.site.customer))].sort()
  return names.map((name) => {
    const metas = demoJobMeta.filter((meta) => meta.site.customer === name)
    const subNames = [...new Set(metas.map(demoSubAccountOf))]
    const sub_accounts = subNames.map((sub) => { const list = metas.filter((m) => demoSubAccountOf(m) === sub); return { name: sub, sites: list.length, delivery: demoDeliveryCounts(list) } }).sort((a, b) => b.sites - a.sites || a.name.localeCompare(b.name))
    return { name, sites: metas.length, business_units: [...new Set(metas.map(demoBusinessUnitOf))].sort(), sub_accounts, delivery: demoDeliveryCounts(metas) }
  })
}

// ------------------------------------------------------------------- Adapter

export interface DemoApiOptions { latencyMs?: number }

export function createDemoApi(options: DemoApiOptions = {}): DashboardApi {
  const latency = options.latencyMs ?? 180
  const settle = async <T,>(value: () => T, signal?: AbortSignal): Promise<T> => {
    if (latency > 0) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, latency)
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
    })
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return value()
  }
  const notAvailable = (action: string) => Promise.reject(new ApiError(0, `${action} is not available in demo mode. Start the API stack to enable it.`, action))

  const summary = (query?: ReportingQuery) => {
    const { period, anchor, range, metas } = scope(query)
    const jobRows = metas.map((meta) => jobRow(meta, range))
    const rows = metas.flatMap((meta) => rowsIn(meta, range))
    const t = totals(rows)
    const prior = totals(metas.flatMap((meta) => rowsIn(meta, priorRange(period, range))))
    const arOpen = sum(jobRows, (r) => r.ar_open)
    const shareOfPortfolio = metas.length / demoJobMeta.length
    const ap = apFor(range, shareOfPortfolio)
    const trailing = monthlyRows(metas, listMonths(addMonths(anchor, -11), anchor))
    const marginPct = pct(t.gp, t.revenue), priorMargin = pct(prior.gp, prior.revenue)
    const laborPct = pct(t.labor, t.revenue), priorLaborPct = pct(prior.labor, prior.revenue)
    const otPct = pct(t.ot, t.hours), priorOt = pct(prior.ot, prior.hours)
    const th = thresholds()
    // The scope's revenue over every account's revenue for the same range and the same non-scope filters.
    const allMetas = demoJobMeta.filter((meta) => matchesFilters(meta, { ...query, scope: 'all', account: undefined, sub_account: undefined }))
    const allRevenue = sum(allMetas.flatMap((meta) => rowsIn(meta, range)), (r) => r.revenue)
    return {
      source, range,
      kpis: {
        revenue_share_of_all: allRevenue ? Math.round((t.revenue / allRevenue) * 10_000) / 10_000 : null,
        revenue: t.revenue, revenue_prior: prior.revenue, gross_profit: t.gp, gross_margin_pct: marginPct ?? 0, labor_cost: t.labor, labor_pct_revenue: laborPct ?? 0,
        hours: t.hours, overtime_hours: t.ot, overtime_pct: otPct ?? 0, scheduled_hours: t.scheduled, hours_variance: t.hours - t.scheduled,
        budget_revenue: t.budget_revenue, budget_labor: t.budget_labor, ar_open: arOpen, dso_days: dsoFor(metas, anchor, arOpen),
        active_jobs: jobRows.filter((r) => r.is_active).length, jobs_below_margin_target: jobRows.filter((r) => (r.gross_margin_pct ?? 100) < th.marginTarget).length,
        ap_invoiced: sum(ap, (r) => r.invoiced), ap_paid: sum(ap, (r) => r.paid),
        ...breakdownFor(metas, (meta) => rowsIn(meta, range)),
      },
      deltas: {
        revenue_pct: prior.revenue ? round1(((t.revenue - prior.revenue) / prior.revenue) * 100) : null,
        gross_margin_pts: marginPct !== null && priorMargin !== null ? round1(marginPct - priorMargin) : null,
        labor_pct_pts: laborPct !== null && priorLaborPct !== null ? round1(laborPct - priorLaborPct) : null,
        overtime_pct_pts: otPct !== null && priorOt !== null ? round1(otPct - priorOt) : null,
        hours_pct: prior.hours ? round1(((t.hours - prior.hours) / prior.hours) * 100) : null,
      },
      monthly: trailing.map(({ month, rows: monthRows, t: mt }) => {
        const apMonth = demoApMonths.filter((r) => r.month === month)
        return { month, revenue: mt.revenue, invoiced_total: mt.invoiced, collected_total: mt.collected, budget_revenue: mt.budget_revenue, labor_cost: mt.labor, budget_labor: mt.budget_labor, gross_profit: mt.gp, hours: mt.hours, overtime_hours: mt.ot, scheduled_hours: mt.scheduled, jobs_reporting: monthRows.filter((r) => r.revenue > 0).length, ap_invoiced: Math.round(sum(apMonth, (r) => r.invoiced) * shareOfPortfolio), ap_paid: Math.round(sum(apMonth, (r) => r.paid) * shareOfPortfolio), ...breakdownFor(metas, (meta) => rowsForMonth(meta, month)) }
      }),
      by_region: groupTotals(jobRows, (r) => r.region),
      by_company: groupTotals(jobRows, (r) => r.company ?? ''),
      by_service_type: groupTotals(jobRows, (r) => r.service_type),
      by_account: groupTotals(jobRows, (r) => r.parent_account).map((g) => ({ ...g, customer_numbers: [...new Set(jobRows.filter((r) => r.parent_account === g.name).map((r) => r.customer_number ?? ''))] })),
    }
  }

  const api: DashboardApi = {
    systemStatus: (signal) => settle(() => ({ database: 'demo', winteam: integration(), marts: { latest_month: null, rebuilt_at: null, job_month_rows: 0 }, forecast: null, sources: sourceRows() }), signal),
    integrationStatus: (signal) => settle(integration, signal),
    financeReference: (signal) => settle(() => ({ configured: false, database_host: null, reference: null, last_load: null }), signal),
    loadFinanceReference: () => notAvailable('Finance reference load'),
    testConnection: () => notAvailable('Connection test'),
    syncResource: () => notAvailable('Resource sync'),
    resetWatermark: () => notAvailable('Watermark reset'),
    syncAll: () => notAvailable('Full sync'),
    rebuildMarts: () => notAvailable('Mart rebuild'),
    rebuildForecasts: () => notAvailable('Forecast rebuild'),
    syncRuns: (limit = 25, signal) => settle(() => ({ runs: demoResources.slice(0, limit).map((name, i) => ({ id: 100 + i, resource_name: name, status: i === 1 ? 'failed' : 'succeeded', started_at: `2026-09-01T05:${String(10 + i * 3).padStart(2, '0')}:00Z`, completed_at: `2026-09-01T05:${String(12 + i * 3).padStart(2, '0')}:00Z`, records_fetched: 120 + i * 37, records_inserted: 18 + i * 5, error_message: i === 1 ? 'Demo run: simulated 429 rate limit, retried on next poll' : null })) }), signal),
    freshness: (signal) => settle(() => ({ resources: demoResources.map((name, i) => ({ resource_name: name, last_status: 'demo', last_completed_at: DEMO_AS_OF, records_fetched: 120 + i * 37, records_inserted: 18 + i * 5, last_error: null, watermark_value: '2026-09-01T05:00:00Z', seconds_since_last_completion: 1800 + i * 60, overdue: false, overdue_after_seconds: 3600, not_entitled: false })), ingestion: { healthy: true, overdue_resources: [], overdue_after_seconds: 3600, poll_seconds: 900, reference_stale: false, reference_stale_after_seconds: 604800 }, sources: sourceRows(), marts: { latest_month: DEMO_LATEST_MONTH, rebuilt_at: DEMO_AS_OF, job_month_rows: demoJobMonths.length, mode: 'demo' } }), signal),
    settings: (signal) => settle(() => ({ settings: demoSettings.map((s): AppSetting => ({ ...s, updated_at: '2026-08-15T14:00:00Z' })) }), signal),
    updateSetting: () => notAvailable('Setting update'),
    dimensions: (signal) => settle(() => ({
      months: [...demoMonths, DEMO_PACE_MONTH],
      month_status: [...demoMonths.map((month) => ({ month, status: 'closed' as const })), { month: DEMO_PACE_MONTH, status: 'in_progress' as const }],
      latest_month: DEMO_PACE_MONTH, latest_closed_month: DEMO_LATEST_MONTH, default_month: DEMO_LATEST_MONTH,
      accounts: [...new Set(demoJobMeta.map((m) => m.site.customer))].sort(), regions: [...new Set(demoJobMeta.map((m) => m.site.region))].sort(),
      branches: [...new Set(demoJobMeta.map((m) => m.site.branch))].sort(), service_types: [...new Set(demoJobMeta.map((m) => m.site.serviceType))].sort(),
      verticals: [...new Set(demoJobMeta.map((m) => m.vertical))].sort(),
      companies: [...new Set(demoJobMeta.map(demoCompanyOf))].sort(),
      delivery_models: [...new Set(demoJobMeta.map(demoDeliveryModelOf))].sort(),
      key_accounts: demoKeyAccountDimensions(),
      other_accounts: demoOtherAccountDimensions(),
      customers: [...new Map(demoJobMeta.map((m) => [m.customer_number, { customer_number: m.customer_number, customer_name: m.site.customer }])).values()],
    }), signal),

    portfolioSummary: (query, signal) => settle(() => summary(query), signal),
    jobs: (query, signal) => settle(() => { const { range, metas } = scope(query); return { source, range, jobs: metas.map((meta) => jobRow(meta, range)) } }, signal),
    siteVendors: (jobNumber, months = 12, signal) => settle(() => {
      // Seeded vendors so the panel has a shape in demo mode; never a live figure.
      const meta = demoJobMeta.find((m) => m.job_number === jobNumber)
      const base = Math.abs((meta?.index ?? 3) + 7) * 4200
      const rows = [
        { vendor_name: 'Complete Facilities Maintenance', vendor_number: 1041, invoices: 6, amount: base * 3, gl_accounts: ['44000'] },
        { vendor_name: 'Brady Plus', vendor_number: 1188, invoices: 21, amount: base, gl_accounts: ['40900'] },
        { vendor_name: 'Sunbelt Rentals, Inc.', vendor_number: 1352, invoices: 4, amount: base / 2, gl_accounts: ['41001'] },
      ]
      const total = rows.reduce((t, r) => t + r.amount, 0)
      return {
        job_number: jobNumber,
        range: { from: DEMO_LATEST_MONTH, to: DEMO_LATEST_MONTH, months },
        total_cost: total,
        vendors: rows.map((r) => ({ ...r, share: total ? r.amount / total : null, last_invoice_date: DEMO_LATEST_MONTH })),
        basis: 'Seeded demo vendors',
      }
    }, signal),
    companycam: (signal) => settle(() => ({
      configured: false, base_url: 'https://api.companycam.com/v2', match_rule: null,
      note: 'Demo mode: site photos are not wired.',
    }), signal),
    job: (jobNumber, months = 24, signal) => settle(() => {
      const meta = demoJobMeta.find((m) => m.job_number === jobNumber)
      if (!meta) throw new ApiError(404, `Job ${jobNumber} not found`, `/jobs/${jobNumber}`)
      const range = resolveRange('T12M', DEMO_LATEST_MONTH)
      const history = (jobMonthsByJob.get(meta.job_number) ?? []).slice(-months).map(({ job_number: _job, ...row }) => row)
      const rng = mulberry32(meta.index * 3 + 1)
      const weekly = history.at(-1)
      const weeks = Array.from({ length: 13 }, (_, i) => {
        const weekStart = new Date(Date.UTC(2026, 8, 6)); weekStart.setUTCDate(weekStart.getUTCDate() - (12 - i) * 7)
        const scheduled = Math.round((weekly?.scheduled_hours ?? 0) / 4.33)
        const actual = Math.round(scheduled * (1 + meta.seed.laborDrift / 100) * (1 + (rng() - 0.5) * 0.08))
        return { week_start: weekStart.toISOString().slice(0, 10), scheduled_hours: scheduled, actual_hours: actual, overtime_hours: Math.round(actual * meta.seed.overtime / 100) }
      })
      const status = seriesStatus(meta)
      return {
        source, job: jobRow(meta, range), history, schedule_vs_actual: weeks,
        invoices: openInvoices().filter((inv) => inv.job_number === meta.job_number),
        forecast: status.ok ? { rows: forecastMetricsFor(meta).flatMap((metric) => siteForecast(meta, metric)), accuracy: forecastMetricsFor(meta).map((metric) => ({ metric, ...siteForecast(meta, metric)[0].accuracy! })) } : null,
      }
    }, signal),
    accounts: (query, signal) => settle(() => {
      const { range, metas } = scope(query)
      const jobRows = metas.map((meta) => jobRow(meta, range))
      const accounts = groupTotals(jobRows, (r) => r.parent_account).map((g): AccountRow => {
        const members = jobRows.filter((r) => r.parent_account === g.name)
        const ar = sum(members, (r) => r.ar_open)
        const weighted = ar ? sum(members, (r) => r.ar_open * (r.days_outstanding_weighted ?? 0)) / ar : null
        const t: Totals = { ...totals([]), revenue: g.revenue, gp: g.gross_profit, labor: g.labor_cost, hours: g.hours, ot: sum(members, (r) => r.overtime_hours), budget_labor: members.some((r) => r.budget_labor !== null) ? sum(members, (r) => r.budget_labor) : null }
        return { parent_account: g.name, customer_numbers: [...new Set(members.map((r) => r.customer_number ?? ''))], jobs: g.jobs, revenue: g.revenue, gross_profit: g.gross_profit, gross_margin_pct: pct(g.gross_profit, g.revenue), labor_cost: g.labor_cost, hours: g.hours, overtime_hours: t.ot, ar_open: ar, days_outstanding_weighted: weighted === null ? null : round1(weighted), status: statusFor(t, weighted).status }
      })
      return { source, range, accounts }
    }, signal),
    arAging: (query, signal) => settle(() => {
      const metas = demoJobMeta.filter((meta) => matchesFilters(meta, query))
      const invoices = openInvoices().filter((inv) => metas.some((m) => m.job_number === inv.job_number))
      const buckets = (Object.keys(bucketLabels) as AgingBucketKey[]).map((bucket) => { const rows = invoices.filter((inv) => inv.aging_bucket === bucket); return { bucket, label: bucketLabels[bucket], amount: sum(rows, (r) => r.open_balance), invoices: rows.length } })
      const byCustomer = new Map<string, AgingCustomer>()
      for (const inv of invoices) {
        const jobMeta = demoJobMeta.find((m) => m.job_number === inv.job_number)
        const entry = byCustomer.get(inv.customer_number ?? '') ?? { customer_number: inv.customer_number ?? '', customer_name: inv.customer_name ?? '', parent_account: inv.parent_account ?? '', current: 0, d30: 0, d60: 0, d90: 0, d90_plus: 0, total: 0, invoices: 0, is_collectible: inv.parent_account !== DEMO_NON_COLLECTIBLE_ACCOUNT, company: jobMeta ? demoCompanyOf(jobMeta) : null }
        entry[inv.aging_bucket ?? 'current'] += inv.open_balance; entry.total += inv.open_balance; entry.invoices += 1
        byCustomer.set(entry.customer_number, entry)
      }
      const totalOpen = sum(invoices, (r) => r.open_balance)
      const customers = [...byCustomer.values()].sort((a, b) => b.total - a.total)
      // Cash application: a payment counts as applied when the open balance is below the invoice amount.
      const applied = invoices.filter((inv) => inv.open_balance < (inv.invoice_total ?? inv.open_balance))
      const nothingApplied = invoices.filter((inv) => inv.open_balance >= (inv.invoice_total ?? inv.open_balance))
      const cash_application = {
        invoices_open: invoices.length, invoices_with_payment_applied: applied.length, pct_with_payment_applied: pct(applied.length, invoices.length),
        open_nothing_applied: sum(nothingApplied, (r) => r.open_balance), open_nothing_applied_over_90: sum(nothingApplied.filter((r) => (r.days_outstanding ?? 0) > 90), (r) => r.open_balance),
        oldest_open_invoice_date: invoices.reduce<string | null>((oldest, inv) => (inv.invoice_date && (oldest === null || inv.invoice_date < oldest) ? inv.invoice_date : oldest), null),
        note: 'An invoice counts as having a payment applied when its amount due is below its invoice amount in the aging snapshot. The aging is only as accurate as cash application in WinTeam: unapplied receipts leave invoices open and age them.',
      }
      return { source, as_of: DEMO_AR_AS_OF, total_open: totalOpen, collectible_open: sum(customers.filter((c) => c.is_collectible !== false), (c) => c.total), buckets, by_customer: customers, dso_days: dsoFor(metas, DEMO_LATEST_MONTH, totalOpen), cash_application }
    }, signal),
    arInvoices: (query: ArInvoicesQuery = {}, signal) => settle(() => {
      // Same scope rule as /ar/aging so the invoice list always reconciles with the buckets.
      const inScope = new Set(demoJobMeta.filter((meta) => matchesFilters(meta, { scope: query.scope, account: query.account, sub_account: query.sub_account, delivery: query.delivery })).map((meta) => meta.job_number))
      const all = openInvoices().filter((inv) => inv.job_number !== null && inScope.has(inv.job_number) && (!query.bucket || inv.aging_bucket === query.bucket) && (!query.customer || inv.customer_number === query.customer || inv.customer_name === query.customer)).sort((a, b) => (b.days_outstanding ?? 0) - (a.days_outstanding ?? 0))
      const limit = query.limit ?? 100, offset = query.offset ?? 0
      return { items: all.slice(offset, offset + limit), total: all.length, limit, offset }
    }, signal),
    apSummary: (query, signal) => settle(() => {
      const { range, metas } = scope(query)
      const share = metas.length / demoJobMeta.length
      const ap = apFor(range, share)
      const byVendor = vendors.map((vendor, v) => { const rows = ap.filter((r) => r.vendor_number === vendor.vendor_number); const invoiced = sum(rows, (r) => r.invoiced), paid = sum(rows, (r) => r.paid); const open = Math.max(0, invoiced - paid); return { vendor_number: vendor.vendor_number, vendor_name: vendor.vendor_name, invoiced, paid, invoices: sum(rows, (r) => r.invoices), open_balance: open, past_due: Math.round(open * [0.35, 0.1, 0.5, 0, 0.2, 0.6, 0.05, 0.3][v % 8]) } }).sort((a, b) => b.invoiced - a.invoiced)
      const monthly = listMonths(range.from, range.to).map((month) => { const rows = ap.filter((r) => r.month === month); return { month, invoiced: sum(rows, (r) => r.invoiced), paid: sum(rows, (r) => r.paid) } })
      const lastMonth = monthly.at(-1)
      const due = Array.from({ length: 4 }, (_, i) => ({ due_week_start: `2026-09-${String(7 + i * 7).padStart(2, '0')}`, amount: Math.round(((lastMonth?.invoiced ?? 0) - (lastMonth?.paid ?? 0)) * [0.35, 0.3, 0.2, 0.15][i]), invoices: 4 + i }))
      return { source, range, kpis: { invoiced: sum(ap, (r) => r.invoiced), paid: sum(ap, (r) => r.paid), invoices: sum(ap, (r) => r.invoices), vendors: demoVendors.length, open_estimate: sum(byVendor, (r) => r.open_balance) }, by_vendor: byVendor, monthly, due_next_30_days: due }
    }, signal),
    laborSummary: (query, signal) => settle(() => {
      const { anchor, range, metas } = scope(query)
      const jobRows = metas.map((meta) => jobRow(meta, range))
      const rows = metas.flatMap((meta) => rowsIn(meta, range))
      const t = totals(rows)
      const blended = t.hours ? t.labor / t.hours : 0
      const th = thresholds()
      const monthly = monthlyRows(metas, listMonths(addMonths(anchor, -11), anchor)).map(({ month, t: mt }) => ({ month, labor_cost: mt.labor, budget_labor: mt.budget_labor, revenue: mt.revenue, labor_pct_revenue: pct(mt.labor, mt.revenue), hours: mt.hours, overtime_hours: mt.ot, scheduled_hours: mt.scheduled }))
      const byAccount = groupTotals(jobRows, (r) => r.parent_account).map((g) => { const members = jobRows.filter((r) => r.parent_account === g.name); return { parent_account: g.name, labor_cost: g.labor_cost, budget_labor: members.some((r) => r.budget_labor !== null) ? sum(members, (r) => r.budget_labor) : null, revenue: g.revenue, hours: g.hours, overtime_hours: sum(members, (r) => r.overtime_hours), labor_pct_revenue: pct(g.labor_cost, g.revenue) } })
      const byJob = jobRows.map((r) => ({ job_number: r.job_number, job_name: r.job_name, parent_account: r.parent_account, labor_cost: r.labor_cost, budget_labor: r.budget_labor, labor_variance: r.labor_variance, hours: r.hours, overtime_hours: r.overtime_hours, overtime_pct: pct(r.overtime_hours, r.hours) ?? 0, scheduled_hours: r.scheduled_hours }))
      const employees = demoEmployees.filter((e) => jobRows.some((r) => r.job_number === e.job_number)).map((e) => { const job = jobRows.find((r) => r.job_number === e.job_number)!; return { employee_source_id: e.employee_source_id, hours: Math.round(job.hours * e.hoursShare), overtime_hours: Math.round(job.overtime_hours * e.overtimeShare), jobs: 1 } }).sort((a, b) => b.overtime_hours - a.overtime_hours).slice(0, 15)
      return {
        source, range,
        definitions: { labor_cost: 'Sum of timekeeping labor cost by service month (demo)', overtime_cost_estimate: 'overtime_hours × blended hourly labor × overtime_multiplier (demo)' },
        kpis: { labor_cost: t.labor, revenue: t.revenue, labor_pct_revenue: pct(t.labor, t.revenue) ?? 0, target_labor_pct: th.targetLaborPct, hours: t.hours, overtime_hours: t.ot, overtime_pct: pct(t.ot, t.hours) ?? 0, overtime_cost_estimate: Math.round(t.ot * blended * settingNumber('overtime_multiplier')), budget_labor: t.budget_labor, labor_variance: t.budget_labor === null ? null : t.labor - t.budget_labor, scheduled_hours: t.scheduled, hours_variance: t.hours - t.scheduled, revenue_per_hour: t.hours ? round1(t.revenue / t.hours) : null, gross_profit_per_hour: t.hours ? round1(t.gp / t.hours) : null },
        monthly, by_account: byAccount, by_job: byJob, overtime_employees: employees,
      }
    }, signal),
    laborPace: (query: LaborPaceQuery = {}, signal) => settle(() => {
      const month = query.month ?? DEMO_PACE_MONTH
      const inProgress = month === DEMO_PACE_MONTH
      const throughDay = inProgress ? 14 : daysInMonth(month)
      const weights = paceWeights(month, throughDay)
      const metas = demoJobMeta.filter((meta) => matchesFilters(meta, { account: query.account, job_number: query.job_number }))
      const rowsFor = (list: DemoJobMeta[]) => list.flatMap((meta) => inProgress ? demoPartialMonth.filter((r) => r.job_number === meta.job_number) : (jobMonthsByJob.get(meta.job_number) ?? []).filter((r) => r.month === month))
      const priorFor = (list: DemoJobMeta[]) => sum(list.flatMap((meta) => (jobMonthsByJob.get(meta.job_number) ?? []).filter((r) => r.month === addMonths(month, -1))), (r) => r.labor_cost)
      const build = (scopeName: PaceRow['scope'], name: string, list: DemoJobMeta[]): PaceRow => {
        const rows = rowsFor(list)
        const laborToDate = sum(rows, (r) => r.labor_cost), hoursToDate = sum(rows, (r) => r.hours)
        const method: PaceRow['projection_method'] = laborToDate === 0 ? 'none' : inProgress ? 'day_of_week_weighted' : 'none'
        const projected = inProgress ? Math.round(laborToDate / weights.fraction) : laborToDate
        const calendar = inProgress ? Math.round(laborToDate / (throughDay / weights.days)) : laborToDate
        const budgetRows = rows.filter((r) => r.budget_labor !== null)
        const budget = budgetRows.length ? Math.round(sum(list.flatMap((meta) => (jobMonthsByJob.get(meta.job_number) ?? []).filter((r) => r.month === addMonths(month, inProgress ? -1 : 0))), (r) => r.budget_labor) * (inProgress ? 1.0035 : 1)) : null
        const budgetToDate = budget === null ? null : Math.round(budget * (inProgress ? weights.fraction : 1))
        const priorMonths = list.flatMap((meta) => (jobMonthsByJob.get(meta.job_number) ?? []).slice(-6)).map((r) => r.labor_cost)
        const rng = mulberry32(name.length * 7 + list.length)
        const rangeN = inProgress ? 6 : 0
        return {
          scope: scopeName, name, labor_to_date: laborToDate, hours_to_date: hoursToDate, projected_labor: projected, projected_hours: inProgress ? Math.round(hoursToDate / weights.fraction) : hoursToDate,
          projection_method: method, projected_calendar: calendar, budget, budget_to_date: budgetToDate, projected_variance: budget === null ? null : projected - budget, pct_over: budget ? round1(((projected - budget) / budget) * 100) : null,
          prior_month_labor: priorFor(list), range_lo: rangeN ? Math.round(projected * (0.965 - rng() * 0.01)) : null, range_hi: rangeN ? Math.round(projected * (1.035 + rng() * 0.01)) : null, range_n: rangeN ? Math.min(rangeN, priorMonths.length) : 0,
          jobs_with_labor: rows.filter((r) => r.labor_cost > 0).length, jobs_with_budget: budgetRows.length,
        }
      }
      const rows: PaceRow[] = query.job_number ? metas.map((meta) => build('job', meta.site.name, [meta])) : query.account ? [build('account', query.account, metas)] : [build('portfolio', 'Portfolio', metas), ...[...new Set(metas.map((m) => m.site.customer))].sort().map((account) => build('account', account, metas.filter((m) => m.site.customer === account)))]
      return { source, month, as_of: inProgress ? DEMO_PACE_AS_OF : `${month.slice(0, 7)}-${daysInMonth(month)}`, days_elapsed: throughDay, days_in_month: weights.days, month_complete: !inProgress, method_notes: { day_of_week_weighted: 'labor_to_date × W_total / W_elapsed; W = weekday 1.0, weekend 0.35 (demo profile)', calendar_proration: 'labor_to_date × days_in_month / days_elapsed', range: 'demo: ±3.5–4.5% around the projection from 6 prior month-ends', labor_cost_basis: 'Seeded daily timekeeping labor cost (demo); the reference source uses hours × the job\'s trailing closed-month rate' }, rows }
    }, signal),
    timekeepingSummary: (query, signal) => settle(() => {
      const { anchor, range, metas } = scope(query)
      const jobRows = metas.map((meta) => jobRow(meta, range))
      const t = totals(metas.flatMap((meta) => rowsIn(meta, range)))
      const lastMonthRows = metas.flatMap((meta) => (jobMonthsByJob.get(meta.job_number) ?? []).filter((r) => r.month === anchor))
      const lastMonth = totals(lastMonthRows)
      const monthWeights = paceWeights(anchor, daysInMonth(anchor))
      const anchorEnd = new Date(`${anchor}T00:00:00Z`); anchorEnd.setUTCMonth(anchorEnd.getUTCMonth() + 1); anchorEnd.setUTCDate(0)
      const daily = Array.from({ length: 56 }, (_, i) => {
        const date = new Date(anchorEnd); date.setUTCDate(date.getUTCDate() - (55 - i))
        const dow = date.getUTCDay()
        const weight = dow === 0 || dow === 6 ? 0.35 : 1
        const rng = mulberry32(i * 17 + metas.length)
        const scheduled = Math.round((lastMonth.scheduled / monthWeights.full) * weight)
        const hours = Math.round((lastMonth.hours / monthWeights.full) * weight * (1 + (rng() - 0.5) * 0.1))
        return { work_date: date.toISOString().slice(0, 10), hours, overtime_hours: Math.round(hours * (lastMonth.hours ? lastMonth.ot / lastMonth.hours : 0) * (dow === 5 || dow === 6 ? 1.6 : 0.8)), scheduled_hours: scheduled, employees: Math.round(lastMonth.employees * (weight === 1 ? 0.95 : 0.4)) }
      })
      const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      const byWeekday = weekdayLabels.map((label, i) => { const isodow = i + 1; const rows = daily.filter((d) => ((new Date(`${d.work_date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1 === isodow); return { isodow, label, avg_hours: rows.length ? Math.round(sum(rows, (r) => r.hours) / rows.length) : 0 } })
      const byBranch = [...new Set(jobRows.map((r) => r.branch))].map((branch) => { const rows = jobRows.filter((r) => r.branch === branch); return { branch, scheduled_hours: sum(rows, (r) => r.scheduled_hours), hours: sum(rows, (r) => r.hours), overtime_hours: sum(rows, (r) => r.overtime_hours) } }).sort((a, b) => b.hours - a.hours)
      return {
        source, range,
        kpis: { hours: t.hours, regular_hours: t.regular, overtime_hours: t.ot, overtime_pct: pct(t.ot, t.hours) ?? 0, scheduled_hours: t.scheduled, hours_variance: t.hours - t.scheduled, employees: sum(jobRows, (r) => r.employee_count), punches: Math.round(t.hours / 7.6), revenue_per_hour: t.hours ? round1(t.revenue / t.hours) : null },
        daily, by_weekday: byWeekday,
        by_job: jobRows.map((r) => ({ job_number: r.job_number, job_name: r.job_name, parent_account: r.parent_account, scheduled_hours: r.scheduled_hours, hours: r.hours, overtime_hours: r.overtime_hours, variance: r.hours - r.scheduled_hours, employees: r.employee_count })),
        by_branch: byBranch,
      }
    }, signal),
    budgetVariance: (query, signal) => settle(() => {
      const { anchor, range, metas } = scope(query)
      const jobRows = metas.map((meta) => jobRow(meta, range))
      const t = totals(metas.flatMap((meta) => rowsIn(meta, range)))
      const subBudget = t.budget_revenue === null ? null : Math.round(t.budget_revenue * 0.04), supBudget = t.budget_revenue === null ? null : Math.round(t.budget_revenue * 0.06)
      const line = (name: BudgetLine['name'], actual: number | null, budget: number | null, favorableWhenOver: boolean): BudgetLine => {
        const variance = actual === null || budget === null ? null : actual - budget
        return { name, actual, budget, variance, variance_pct: variance === null || !budget ? null : round1((variance / budget) * 100), favorable: variance === null ? null : favorableWhenOver ? variance >= 0 : variance <= 0 }
      }
      const gpBudget = t.budget_revenue === null || t.budget_labor === null ? null : t.budget_revenue - t.budget_labor - (subBudget ?? 0) - (supBudget ?? 0) - Math.round(t.budget_labor / 3)
      return {
        source, range,
        lines: [line('Revenue', t.revenue, t.budget_revenue, true), line('Labor', t.labor, t.budget_labor, false), line('Subcontract budget', null, subBudget, false), line('Supplies budget', null, supBudget, false), line('Gross profit', t.gp, gpBudget, true)],
        monthly: monthlyRows(metas, listMonths(addMonths(anchor, -11), anchor)).map(({ month, t: mt }) => ({ month, revenue: mt.revenue, budget_revenue: mt.budget_revenue, labor_cost: mt.labor, budget_labor: mt.budget_labor })),
        by_account: groupTotals(jobRows, (r) => r.parent_account).map((g) => { const members = jobRows.filter((r) => r.parent_account === g.name); const anyBudget = members.some((r) => r.budget_labor !== null); return { parent_account: g.name, revenue: g.revenue, budget_revenue: anyBudget ? sum(members, (r) => r.budget_revenue) : null, labor_cost: g.labor_cost, budget_labor: anyBudget ? sum(members, (r) => r.budget_labor) : null } }),
        by_job: jobRows.map((r) => ({ job_number: r.job_number, job_name: r.job_name, revenue: r.revenue, budget_revenue: r.budget_revenue, labor_cost: r.labor_cost, budget_labor: r.budget_labor, labor_variance_pct: r.budget_labor ? round1(((r.labor_cost - r.budget_labor) / r.budget_labor) * 100) : null })),
        coverage: { jobs_with_budget: jobRows.filter((r) => r.budget_labor !== null).length, jobs_total: jobRows.length },
      }
    }, signal),
    alerts: (query, signal) => settle(() => {
      const { range, metas } = scope(query)
      const th = thresholds()
      const alerts: AlertRow[] = []
      for (const row of metas.map((meta) => jobRow(meta, range))) {
        const push = (severity: AlertRow['severity'], type: string, detail: string, value: number | null, threshold: number | null) => alerts.push({ id: `${row.job_number}-${type.replace(/\s+/g, '-').toLowerCase()}`, severity, type, job_number: row.job_number, job_name: row.job_name, parent_account: row.parent_account, branch: row.branch, detail, metric_value: value, threshold })
        const margin = row.gross_margin_pct
        if (margin !== null && margin < th.marginTarget) push(margin < th.marginTarget - th.marginCriticalDelta ? 'critical' : 'watch', 'Margin below target', `${margin.toFixed(1)}% gross margin vs ${th.marginTarget}% target`, margin, th.marginTarget)
        const laborOver = row.budget_labor ? ((row.labor_cost - row.budget_labor) / row.budget_labor) * 100 : null
        if (laborOver !== null && laborOver > th.laborWatch) push(laborOver > th.laborCritical ? 'critical' : 'watch', 'Labor over budget', `${laborOver.toFixed(1)}% above budget`, round1(laborOver), th.laborWatch)
        const ot = row.hours ? (row.overtime_hours / row.hours) * 100 : 0
        if (ot > th.otWatch) push(ot > th.otCritical ? 'critical' : 'watch', 'Elevated overtime', `${ot.toFixed(1)}% of hours`, round1(ot), th.otWatch)
        if (row.days_outstanding_weighted !== null && row.days_outstanding_weighted > th.arWatch) push(row.days_outstanding_weighted > th.arCritical ? 'critical' : 'watch', 'Aging receivable', `${Math.round(row.days_outstanding_weighted)} weighted days outstanding`, row.days_outstanding_weighted, th.arWatch)
      }
      return { source, range, alerts: alerts.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1)) }
    }, signal),

    forecasts: (query: ForecastsQuery = {}, signal) => settle(() => {
      const metric = query.metric ?? 'revenue'
      // The forecast page has its own account selector and no global scope control: its portfolio row means every account.
      const metas = demoJobMeta.filter((meta) => matchesFilters(meta, { account: query.account, scope: 'all' }))
      const rows: ForecastRow[] = []
      const notForecast: SeriesStatus[] = []
      const forecastMetas: DemoJobMeta[] = []
      for (const meta of metas) {
        const status = seriesStatus(meta, metric)
        if (status.ok) { rows.push(...siteForecast(meta, metric)); forecastMetas.push(meta) }
        else notForecast.push(seriesStatusRow(meta, metric, status))
      }
      // Last closed month actuals for the account (or portfolio) and the share the forecast sites cover.
      const lastClosed = (list: DemoJobMeta[]) => list.flatMap((meta) => rowsForMonth(meta, DEMO_LATEST_MONTH))
      const allLast = lastClosed(metas), forecastLast = lastClosed(forecastMetas)
      const coveragePct = pct(sum(forecastLast, (r) => r.revenue), sum(allLast, (r) => r.revenue))
      const isAccount = Boolean(query.account)
      const aggregate: ForecastRow[] = [1, 2, 3].map((h) => {
        const step = rows.filter((r) => r.horizon_step === h)
        const point = sum(step, (r) => r.point)
        return {
          ...step[0], job_number: isAccount ? '__ACCOUNT__' : '__ALL__', job_name: query.account ?? 'Portfolio', point, lo: sum(step, (r) => r.lo), hi: sum(step, (r) => r.hi),
          method: isAccount ? 'sum_of_site_forecasts' : 'sum_of_sites',
          explanation: isAccount ? `Sum of ${step.length} of ${metas.length} ${query.account} site forecasts for this horizon, covering ${coveragePct === null ? '—' : `${coveragePct}%`} of the account's last-closed revenue; bands are summed (conservative).` : `Sum of ${step.length} site forecasts for this horizon; bands are summed (conservative).`,
          volatility_class: isAccount ? 'account' : 'portfolio', accuracy: { n_backtests: 6, median_ape: 2.4, mase: 0.81, coverage: 0.81 }, excluded_months: [], disruption: null, delivery_model: null, parent_account: query.account ?? null,
        }
      })
      const ordered = [...aggregate, ...rows.sort((a, b) => a.horizon_step - b.horizon_step || b.point - a.point)]
      const account_summary = isAccount ? {
        account: query.account!, sites_total: metas.length, sites_forecast: forecastMetas.length, sites_not_forecast: metas.length - forecastMetas.length,
        self_perform_sites: metas.filter((m) => demoDeliveryModelOf(m) === 'self_perform').length, subcontracted_sites: metas.filter((m) => demoDeliveryModelOf(m) === 'subcontracted').length,
        last_closed_month: DEMO_LATEST_MONTH,
        last_closed_actual: { revenue: sum(allLast, (r) => r.revenue), labor_cost: sum(allLast, (r) => r.labor_cost), subcontract_cost: sum(allLast, subcontractCostOf), gross_profit: sum(allLast, (r) => r.gross_profit) },
        forecast_coverage_pct: coveragePct,
      } : undefined
      return { source, metric, run: runMeta, rows: rows.length ? ordered : [], not_forecast: notForecast, ...(account_summary ? { account_summary } : {}) }
    }, signal),
    forecastMeta: (signal) => settle(() => ({ run: runMeta, source }), signal),
    forecastHistory: (query: ForecastsQuery = {}, signal) => settle(() => ({ rows: historyRows(demoJobMeta.filter((meta) => matchesFilters(meta, { account: query.account }))) }), signal),
    forecastTrackRecord: (query: TrackRecordQuery = {}, signal) => settle(() => {
      const metric = query.metric ?? 'revenue', jobNumber = query.job_number ?? '__ALL__'
      const metas = jobNumber === '__ALL__' ? demoJobMeta.filter((m) => seriesStatus(m, metric).ok) : demoJobMeta.filter((m) => m.job_number === jobNumber)
      return { metric, job_number: jobNumber, rows: trackRecord(metas, metric, jobNumber) }
    }, signal),
    forecastJob: (jobNumber, signal) => settle(() => {
      const meta = demoJobMeta.find((m) => m.job_number === jobNumber)
      if (!meta) throw new ApiError(404, `Job ${jobNumber} not found`, `/forecasts/${jobNumber}`)
      const metrics = forecastMetricsFor(meta)
      const rows = metrics.flatMap((metric) => siteForecast(meta, metric))
      return { job_number: meta.job_number, job_name: meta.site.name, rows, accuracy: metrics.map((metric) => ({ metric, ...siteForecast(meta, metric)[0].accuracy! })), history: historyRows([meta]), not_forecast: FORECAST_METRICS.filter((metric) => !metrics.includes(metric)).map((metric) => seriesStatusRow(meta, metric, seriesStatus(meta, metric))) }
    }, signal),
    // Executive labor P&L (weekly)
    executiveLaborPl: (query: ExecutiveLaborPlQuery = {}, signal) => settle(() => demoExecutiveLaborPl(query), signal),
    executiveAccounts: (signal) => settle(() => ({ accounts: demoExecutiveAccounts(), source }), signal),
  }

  function sourceRows(): SourceStatus[] {
    return [
      { name: 'winteam_api', configured: false, enabled: false, last_status: 'demo', last_completed_at: DEMO_AS_OF, records: 0 },
      { name: 'finance_reference', configured: false, enabled: false, last_status: null, last_completed_at: null, records: 0 },
    ]
  }

  function integration() {
    return { enabled: false, configured: false, base_url_host: null, resources: demoResources.map((name, i) => ({ name, enabled: true, kind: i < 2 ? 'dimension' : 'fact', last_status: 'demo', last_completed_at: DEMO_AS_OF, records_fetched: 120 + i * 37, watermark: '2026-09-01T05:00:00Z' })), poll_seconds: 300 }
  }

  return api
}
