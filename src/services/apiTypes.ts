/**
 * Typed interfaces for the Crane IFS reporting API (docs/api-contract.md, v1).
 * Snake_case keys mirror the wire format exactly. Anything the contract leaves
 * unspecified (e.g. mart.v_ar_open row columns) is typed permissively and flagged
 * in docs/frontend.md rather than invented as a server field.
 */

export type Period = 'MTD' | 'QTD' | 'YTD' | 'T12M'
export type IsoMonth = string // "2026-08-01"
export type JobStatus = 'Healthy' | 'Watch' | 'Critical'
export type SourceMode = 'live' | 'empty'
/** Which server-side source filled the marts (Finance reference source section of the contract). */
export type PrimarySource = 'winteam_api' | 'finance_reference' | 'none'

export interface SourceBlock {
  mode: SourceMode
  as_of: string | null
  /** When WinTeam data was last synced (observed on live payloads; optional in the contract text). */
  synced_at?: string | null
  latest_month: IsoMonth | null
  stale: boolean
  /** Added with the finance reference source; absent on older API builds. */
  primary_source?: PrimarySource
  /** AR/AP aging snapshot date when the reference source is primary. */
  ar_as_of?: string | null
}

/** Account grouping requested by the browser (contract "Reporting scope: key accounts first"). */
export type ScopeMode = 'key' | 'all' | 'other'
/** What the server actually reported: the requested scope, or `account` when one account was selected. */
export type ScopeEcho = ScopeMode | 'account'

/** `range.scope` on every reporting payload: what the numbers cover. */
export interface ScopeBlock {
  mode: ScopeEcho
  /** Display label, e.g. "Key accounts" or the account name. */
  label: string
  /** Parent accounts included in the response. */
  accounts: string[]
  sites: number
}

export interface RangeBlock {
  from: IsoMonth
  to: IsoMonth
  months: number
  /** Echoed by the live API; not required by the contract text. */
  anchor?: IsoMonth
  period?: Period
  /** Added 2026-09-09; absent on older API builds. */
  scope?: ScopeBlock
}

export interface ReportingQuery {
  period?: Period
  month?: IsoMonth
  /** Default `key` server-side; ignored when `account` is set, so the browser omits it then. */
  scope?: ScopeMode
  account?: string
  /** Second level under a key account; requires `account` (422 otherwise). */
  sub_account?: string
  /** Omitted when the browser filter is `all`. */
  delivery?: DeliveryModel
  region?: string
  branch?: string
  service_type?: string
  vertical?: string
  /** Exact match on mart.job_month.company (finance reference source). */
  company?: string
  job_number?: string
}

// ---------------------------------------------------------------- Platform

export interface IntegrationResource {
  name: string
  enabled: boolean
  kind: string
  last_status: string | null
  last_completed_at: string | null
  records_fetched: number | null
  watermark: string | null
  entitled?: boolean | null
}

export interface IntegrationStatus {
  enabled: boolean
  configured: boolean
  base_url_host: string | null
  resources: IntegrationResource[]
  poll_seconds: number
  normalize_enabled?: boolean
}

export interface MartsStatus {
  latest_month: IsoMonth | null
  rebuilt_at: string | null
  job_month_rows: number
}

export interface ForecastStatus {
  run_id: string | number
  engine_version: string
  latest_closed_month: IsoMonth | null
  generated_at: string
}

/** One row per server-side source (winteam_api, finance_reference). */
export interface SourceStatus {
  name: string
  configured: boolean
  enabled: boolean
  last_status: string | null
  last_completed_at: string | null
  records: number | null
}

export interface SystemStatus {
  /** Live API returns an object such as {ok: true}; older builds returned a string. */
  database: string | { ok: boolean; [extra: string]: unknown }
  winteam: IntegrationStatus
  marts: MartsStatus
  forecast: ForecastStatus | null
  /** Added with the finance reference source. */
  sources?: SourceStatus[]
}

export interface FinanceReferenceCoverage {
  job_cost_months: [IsoMonth | null, IsoMonth | null] | null
  timekeeping_max_date: string | null
  ar_snapshot_date: string | null
  ap_snapshot_date: string | null
}

export interface LoadedTable { name: string; rows: number }

export interface FinanceReferenceLoad {
  run_id: string | number
  status: string
  started_at: string | null
  completed_at: string | null
  tables: LoadedTable[]
}

/** GET /integrations/finance-reference */
export interface FinanceReferenceStatus {
  configured: boolean
  database_host: string | null
  reference: FinanceReferenceCoverage | null
  last_load: FinanceReferenceLoad | null
}

/** POST /integrations/finance-reference/load (admin, long-running) */
export interface FinanceReferenceLoadResult {
  run_id: string | number
  tables: LoadedTable[]
  marts: RebuildResult
  seconds: number
}

export interface ConnectionTestResult {
  ok: boolean
  resource: string
  records_in_probe: number
  total_count: number | null
}

export interface WatermarkResetResult { resource: string; watermark_removed: boolean; next_sync: string }

export interface SyncRunResult {
  run_id: string | number
  resource: string
  status: string
  fetched: number
  inserted: number
  normalized: number
}

export interface ForecastBuildResult {
  run_id: string | number
  forecast_rows: number
  accuracy_rows: number
  track_rows: number
  status_rows: number
  sites_forecast: number
}

export interface RebuildResult {
  job_month_rows: number
  portfolio_month_rows: number
  forecast: ForecastBuildResult | null
  seconds: number
}

export interface FullSyncResult {
  runs: SyncRunResult[]
  marts: RebuildResult
}

export interface SyncRun {
  id: string | number
  resource_name: string
  status: string
  started_at: string
  completed_at: string | null
  records_fetched: number | null
  records_inserted: number | null
  error_message: string | null
}

export interface SyncRunsResponse {
  runs: SyncRun[]
}

export interface FreshnessResource {
  resource_name: string
  last_status: string | null
  last_completed_at: string | null
  records_fetched: number | null
  records_inserted: number | null
  last_error: string | null
  watermark_value: string | null
  seconds_since_last_completion: number | null
  /** The last run is older than `overdue_after_seconds`. null when the resource is not on the
   *  worker's schedule (a retired name, or a finance_reference loader step). */
  overdue: boolean | null
  overdue_after_seconds: number | null
  /** The tenant is not entitled to this resource (HTTP 403); it never completes and is never overdue. */
  not_entitled: boolean
}

export interface IngestionHealth {
  /** False when a polled WinTeam resource is overdue OR the finance_reference export is stale. */
  healthy: boolean
  overdue_resources: string[]
  overdue_after_seconds: number
  poll_seconds: number
  /** The hand-loaded job-cost export is behind; the newest P&L months carry labor without revenue. */
  reference_stale?: boolean
  reference_stale_after_seconds?: number
}

export interface FreshnessResponse {
  resources: FreshnessResource[]
  /** Whether every polled resource has completed within its window. A hung worker leaves the run
   *  rows saying "succeeded", so this is the only field that distinguishes live from stalled. */
  ingestion?: IngestionHealth
  /** Per-source run summary when the API exposes both sources here (mirrors system/status.sources). */
  sources?: SourceStatus[]
  marts: MartsStatus & { last_rebuild_status?: string | null; portfolio_month_rows?: number } & Record<string, unknown>
}

/** One vendor paid to work a site, from AP GL distributions (booked cost, not apportioned). */
export interface SiteVendor {
  vendor_name: string
  vendor_number: number | null
  invoices: number
  amount: number
  /** Share of the site's total distributed AP cost; null when the total is zero. */
  share: number | null
  last_invoice_date: string | null
  gl_accounts: string[]
}

export interface SiteVendorsResponse {
  job_number: string
  range: RangeBlock
  total_cost: number
  vendors: SiteVendor[]
  basis: string
}

/** Whether site photos are wired. The token never leaves the server. */
export interface CompanyCamStatus {
  configured: boolean
  base_url: string
  match_rule: string | null
  note?: string | null
}

export type SettingValue = string | number | boolean | null | Record<string, unknown> | unknown[]

export interface AppSetting {
  key: string
  value: SettingValue
  description: string | null
  updated_at: string | null
  updated_by?: string | null
}

export interface SettingsResponse {
  settings: AppSetting[]
}

export type MonthStatusKind = 'closed' | 'in_progress' | 'no_revenue'

export interface MonthStatus {
  month: IsoMonth
  status: MonthStatusKind
}

export interface DimensionsResponse {
  months: IsoMonth[]
  /** One entry per month in `months`; in-progress months are selectable but flagged. */
  month_status: MonthStatus[]
  latest_month: IsoMonth | null
  /** Latest month that is invoiced and past the close lag. */
  latest_closed_month: IsoMonth | null
  /** The anchor the server uses when `month` is omitted (= latest closed month). */
  default_month: IsoMonth | null
  accounts: string[]
  regions: string[]
  branches: string[]
  service_types: string[]
  verticals: string[]
  /** Finance reference source: legal entities and delivery models present in the marts. */
  companies?: string[]
  delivery_models?: string[]
  /** Key accounts (setting `key_accounts`) with their sub-accounts; added 2026-09-09. */
  key_accounts?: KeyAccountDimension[]
  /** The long tail, ordered by revenue desc for the latest closed month; added 2026-09-09. */
  other_accounts?: OtherAccountDimension[]
  customers: { customer_number: string; customer_name: string }[]
}

/** One entry of `/dimensions.key_accounts`. */
export interface KeyAccountDimension {
  name: string
  /** Display label, e.g. "FedEx (incl. FXE, FXG)". */
  label: string
  sites: number
  sub_accounts: SubAccountDimension[]
}

export interface SubAccountDimension {
  name: string
  sites: number
}

/** One entry of `/dimensions.other_accounts`. */
export interface OtherAccountDimension {
  name: string
  sites: number
}

// --------------------------------------------------------------- Reporting

export interface PortfolioKpis {
  /**
   * The scope's revenue divided by every account's revenue for the same range (a fraction, not
   * percentage points). Added 2026-09-09; absent on older API builds.
   */
  revenue_share_of_all?: number | null
  revenue: number
  revenue_prior: number
  gross_profit: number
  gross_margin_pct: number
  labor_cost: number
  labor_pct_revenue: number
  hours: number
  overtime_hours: number
  overtime_pct: number
  scheduled_hours: number
  hours_variance: number
  budget_revenue: number | null
  budget_labor: number | null
  ar_open: number
  dso_days: number | null
  active_jobs: number
  jobs_below_margin_target: number
  ap_invoiced: number
  ap_paid: number
  /** Direct-cost breakdown (finance reference source); absent on the WinTeam API source. */
  subcontract_cost?: number
  supplies_cost?: number
  other_direct_cost?: number
  payroll_ti_cost?: number
  direct_cost?: number
}

/** The optional direct-cost breakdown shared by kpis, monthly rows and job rows. */
export type CostBreakdown = Pick<PortfolioKpis, 'subcontract_cost' | 'supplies_cost' | 'other_direct_cost' | 'payroll_ti_cost' | 'direct_cost'>

export interface PortfolioDeltas {
  revenue_pct: number | null
  gross_margin_pts: number | null
  labor_pct_pts: number | null
  overtime_pct_pts: number | null
  hours_pct: number | null
}

export interface PortfolioMonth {
  month: IsoMonth
  revenue: number
  invoiced_total: number
  collected_total: number
  budget_revenue: number | null
  labor_cost: number
  budget_labor: number | null
  gross_profit: number
  hours: number
  overtime_hours: number
  scheduled_hours: number
  jobs_reporting: number
  ap_invoiced: number
  ap_paid: number
  subcontract_cost?: number
  supplies_cost?: number
  other_direct_cost?: number
  payroll_ti_cost?: number
  direct_cost?: number
}

export interface GroupTotals {
  name: string
  revenue: number
  gross_profit: number
  labor_cost: number
  hours: number
  jobs: number
}

export interface AccountTotals extends GroupTotals {
  customer_numbers: string[]
}

export interface PortfolioSummary {
  source: SourceBlock
  range: RangeBlock
  kpis: PortfolioKpis
  deltas: PortfolioDeltas
  monthly: PortfolioMonth[]
  by_region: GroupTotals[]
  by_service_type: GroupTotals[]
  by_account: AccountTotals[]
  /** Finance reference source: totals by legal entity. */
  by_company?: GroupTotals[]
}

export type DeliveryModel = 'self_perform' | 'subcontracted'
export type GeoPrecision = 'exact' | 'city_center'

export interface JobRow {
  job_key: number
  job_number: string
  job_name: string
  parent_account: string
  customer_number: string | null
  region: string
  branch: string
  service_type: string
  vertical: string
  manager_name: string
  city: string
  state_province: string
  country_code: string
  latitude: number | null
  longitude: number | null
  is_active: boolean
  date_to_start: string | null
  revenue: number
  invoiced_total: number
  collected_total: number
  gross_profit: number
  gross_margin_pct: number | null
  labor_cost: number
  burden_cost: number
  hours: number
  regular_hours: number
  overtime_hours: number
  scheduled_hours: number
  budget_revenue: number | null
  budget_labor: number | null
  labor_variance: number | null
  hours_variance: number
  employee_count: number
  ar_open: number
  days_outstanding_weighted: number | null
  last_invoice_date: string | null
  last_work_date: string | null
  months_reporting: number
  status: JobStatus
  status_reasons: string[]
  // ---- Finance reference source additions (optional: the WinTeam API source omits them)
  company?: string | null
  delivery_model?: DeliveryModel | null
  /** 'city_center' = placed from sources/geo/city_centroids.json, not the site address. */
  geo_precision?: GeoPrecision | null
  subcontract_cost?: number
  supplies_cost?: number
  other_direct_cost?: number
  payroll_ti_cost?: number
  /** True when the job exists only in AR invoices (no job-cost P&L rows). */
  is_collectible_ar_only?: boolean
}

export interface JobsResponse {
  source: SourceBlock
  range: RangeBlock
  jobs: JobRow[]
}

/** mart.job_month row. The contract references the mart table without listing columns; these are the columns the contract uses elsewhere. */
export interface JobMonthRow {
  month: IsoMonth
  revenue: number
  invoiced_total: number
  collected_total: number
  budget_revenue: number | null
  labor_cost: number
  burden_cost: number
  budget_labor: number | null
  gross_profit: number
  hours: number
  regular_hours: number
  overtime_hours: number
  scheduled_hours: number
  employee_count: number
  /** Present on the live API: 'ok' | 'warning' | ... plus the reasons. */
  data_quality_status?: string | null
  quality_notes?: string[] | null
  [extra: string]: unknown
}

export interface ScheduleWeek {
  week_start: string
  scheduled_hours: number
  actual_hours: number
  overtime_hours: number
}

/** mart.v_ar_open row as observed on the live API (the contract text only says "mart.v_ar_open row"). */
export interface ArInvoiceRow {
  ar_invoice_key?: number
  invoice_number: string
  customer_number: string | null
  customer_name: string | null
  parent_account: string | null
  parent_account_key?: number | null
  job_number: string | null
  job_name: string | null
  invoice_date: string | null
  terms?: string | null
  invoice_total: number | null
  amount_paid?: number | null
  open_balance: number
  collection_status?: string | null
  days_outstanding: number | null
  aging_bucket: AgingBucketKey | null
  [extra: string]: unknown
}

export interface JobDetailResponse {
  source: SourceBlock
  range?: RangeBlock
  job: JobRow
  history: JobMonthRow[]
  schedule_vs_actual: ScheduleWeek[]
  invoices: ArInvoiceRow[]
  forecast: { rows: ForecastRow[]; accuracy: AccuracyRow[]; run_id?: string | number } | null
}

export interface AccountRow {
  status_reasons?: string[]
  parent_account: string
  customer_numbers: string[]
  jobs: number
  revenue: number
  gross_profit: number
  gross_margin_pct: number | null
  labor_cost: number
  hours: number
  overtime_hours: number
  ar_open: number
  days_outstanding_weighted: number | null
  status: JobStatus
}

export interface AccountsResponse {
  source: SourceBlock
  range: RangeBlock
  accounts: AccountRow[]
}

export type AgingBucketKey = 'current' | 'd30' | 'd60' | 'd90' | 'd90_plus'

export interface AgingBucket {
  bucket: AgingBucketKey
  label: string
  amount: number
  invoices: number
}

export interface AgingCustomer {
  customer_number: string
  customer_name: string
  parent_account: string
  current: number
  d30: number
  d60: number
  d90: number
  d90_plus: number
  total: number
  invoices: number
  /** False for intercompany / settlement customers per the ar_treatment_rules setting. */
  is_collectible?: boolean
  company?: string | null
}

/** Cash-application disclosure computed from the latest aging snapshot (`amount_due < invoice_amount` = a payment was applied). */
export interface ArCashApplication {
  invoices_open: number
  invoices_with_payment_applied: number
  pct_with_payment_applied: number | null
  open_nothing_applied: number
  open_nothing_applied_over_90: number
  oldest_open_invoice_date: string | null
  note: string
}

export interface ArAgingResponse {
  source: SourceBlock
  as_of: string | null
  total_open: number
  /** Total excluding non-collectible (intercompany / settlement) customers; present with the reference source. */
  collectible_open?: number | null
  buckets: AgingBucket[]
  by_customer: AgingCustomer[]
  dso_days: number | null
  cash_application?: ArCashApplication | null
}

export interface ArInvoicesQuery {
  bucket?: AgingBucketKey
  customer?: string
  /** Scope params: `/ar/*` takes the same set as every other reporting endpoint. */
  scope?: ScopeMode
  account?: string
  sub_account?: string
  delivery?: DeliveryModel
  limit?: number
  offset?: number
}

export interface ArInvoicesResponse {
  items: ArInvoiceRow[]
  total: number
  limit: number
  offset: number
}

export interface ApSummary {
  source: SourceBlock
  range: RangeBlock
  kpis: { invoiced: number; paid: number; invoices: number; vendors: number; open_estimate: number | null; paid_through?: string | null; open_balance?: number | null; past_due?: number | null }
  by_vendor: { vendor_number: string; vendor_name: string; invoiced: number; paid: number; invoices: number; open_balance?: number | null; past_due?: number | null }[]
  monthly: { month: IsoMonth; invoiced: number; paid: number }[]
  due_next_30_days: { due_week_start: string; amount: number; invoices: number }[]
}

export interface LaborKpis {
  labor_cost: number
  revenue: number
  labor_pct_revenue: number
  target_labor_pct: number | null
  hours: number
  overtime_hours: number
  overtime_pct: number
  overtime_cost_estimate: number
  budget_labor: number | null
  labor_variance: number | null
  scheduled_hours: number
  hours_variance: number
  revenue_per_hour: number | null
  gross_profit_per_hour: number | null
}

export interface LaborMonth {
  month: IsoMonth
  labor_cost: number
  budget_labor: number | null
  revenue: number
  labor_pct_revenue: number | null
  hours: number
  overtime_hours: number
  scheduled_hours: number
}

export interface LaborAccount {
  parent_account: string
  labor_cost: number
  budget_labor: number | null
  revenue: number
  hours: number
  overtime_hours: number
  labor_pct_revenue: number | null
}

export interface LaborJob {
  job_number: string
  job_name: string
  parent_account: string
  labor_cost: number
  budget_labor: number | null
  labor_variance: number | null
  hours: number
  overtime_hours: number
  overtime_pct: number
  scheduled_hours: number
}

export interface OvertimeEmployee {
  employee_source_id: string
  hours: number
  overtime_hours: number
  jobs: number
}

export interface LaborSummary {
  source: SourceBlock
  range: RangeBlock
  /** Live API adds human-readable derivations (e.g. overtime_cost_estimate). */
  definitions?: Record<string, string>
  kpis: LaborKpis
  monthly: LaborMonth[]
  by_account: LaborAccount[]
  by_job: LaborJob[]
  overtime_employees: OvertimeEmployee[]
}

export type PaceMethod = 'day_of_week_weighted' | 'calendar_proration' | 'none'

export interface PaceRow {
  scope: 'portfolio' | 'account' | 'job'
  name: string
  labor_to_date: number
  hours_to_date: number
  projected_labor: number
  projected_hours: number
  projection_method: PaceMethod
  projected_calendar: number
  budget: number | null
  budget_to_date: number | null
  projected_variance: number | null
  pct_over: number | null
  prior_month_labor: number
  range_lo: number | null
  range_hi: number | null
  range_n: number
  jobs_with_labor: number
  jobs_with_budget: number
  profile_weekdays?: number
  month_complete?: boolean
}

export interface LaborPaceQuery {
  month?: IsoMonth
  account?: string
  job_number?: string
}

export interface LaborPace {
  source: SourceBlock
  month: IsoMonth
  as_of: string
  days_elapsed: number
  days_in_month: number
  month_complete?: boolean
  /** Live API: plain-language description of each projection method and the measured range. */
  method_notes?: Record<string, string>
  rows: PaceRow[]
}

export interface TimekeepingSummary {
  source: SourceBlock
  range: RangeBlock
  kpis: {
    hours: number
    regular_hours: number
    overtime_hours: number
    overtime_pct: number
    scheduled_hours: number
    hours_variance: number
    employees: number
    punches: number
    revenue_per_hour: number | null
  }
  daily: { work_date: string; hours: number; overtime_hours: number; scheduled_hours: number; employees: number }[]
  by_weekday: { isodow: number; label: string; avg_hours: number }[]
  by_job: { job_number: string; job_name: string; parent_account: string; scheduled_hours: number; hours: number; overtime_hours: number; variance: number; employees: number }[]
  by_branch: { branch: string; scheduled_hours: number; hours: number; overtime_hours: number }[]
}

/** The reference source names the vendor lines "Subcontract" / "Supplies" and fills their actuals; the API source keeps the budget-only names. */
export type BudgetLineName = 'Revenue' | 'Labor' | 'Subcontract' | 'Supplies' | 'Subcontract budget' | 'Supplies budget' | 'Gross profit'

export interface BudgetLine {
  name: BudgetLineName
  actual: number | null
  budget: number | null
  variance: number | null
  variance_pct: number | null
  favorable: boolean | null
}

export interface BudgetVariance {
  source: SourceBlock
  range: RangeBlock
  lines: BudgetLine[]
  monthly: { month: IsoMonth; revenue: number; budget_revenue: number | null; labor_cost: number; budget_labor: number | null }[]
  by_account: { parent_account: string; revenue: number; budget_revenue: number | null; labor_cost: number; budget_labor: number | null }[]
  by_job: { job_number: string; job_name: string; revenue: number; budget_revenue: number | null; labor_cost: number; budget_labor: number | null; labor_variance_pct: number | null }[]
  coverage: { jobs_with_budget: number; jobs_total: number }
}

export type AlertSeverity = 'critical' | 'watch'

export interface AlertRow {
  id: string | number
  severity: AlertSeverity
  type: string
  job_number: string
  job_name: string
  parent_account: string
  branch: string
  detail: string
  metric_value: number | null
  threshold: number | null
}

export interface AlertsResponse {
  source: SourceBlock
  range: RangeBlock
  alerts: AlertRow[]
}

// ------------------------------------------------------------- Forecasting

export type ForecastMetric = 'revenue' | 'gross_profit' | 'labor_cost' | 'subcontract_cost'

/** Aggregate row identifiers: `__ALL__` = whole portfolio (only when no account is selected); `__ACCOUNT__` = the selected account. */
export const PORTFOLIO_ROW = '__ALL__'
export const ACCOUNT_ROW = '__ACCOUNT__'
/** Lead row of a run narrowed by scope rather than by account (routers/forecast.py). */
export const SCOPE_ROW = '__SCOPE__'

export interface RunMeta {
  run_id: string | number
  engine_version: string
  generated_at: string
  latest_closed_month: IsoMonth
  horizon_months: number
  dataset: Record<string, unknown>
  gates: Record<string, unknown>
  coverage: Record<string, unknown>
  disruption: Record<string, unknown>
  portfolio: Record<string, unknown>
  assumptions: string[]
  initiated_by?: string | null
  metrics?: string[]
  target_name?: string | null
}

/** GET /forecasts/meta on the live API wraps the run: `{run, source}`. The client normalizes the bare-RunMeta form into this shape too. */
export interface ForecastMetaResponse {
  run: RunMeta | null
  source?: SourceBlock
}

export interface ForecastAccuracy {
  n_backtests: number
  median_ape: number | null
  mase: number | null
  coverage: number | null
}

export interface ForecastRow {
  job_number: string
  job_name: string
  metric: ForecastMetric
  basis_month: IsoMonth
  forecast_month: IsoMonth
  horizon_step: number
  point: number
  lo: number
  hi: number
  method: string
  explanation: string
  n_history: number
  status: string
  volatility_class: string | null
  input_months: IsoMonth[]
  excluded_months: { month: IsoMonth; reason: string }[]
  method_selection: Record<string, unknown>
  interval: Record<string, unknown>
  disruption: Record<string, unknown> | null
  identity: Record<string, unknown> | null
  quality: Record<string, unknown>
  engine_version: string
  accuracy: ForecastAccuracy | null
  /** Added 2026-09-02; absent on older runs and on aggregate rows. */
  delivery_model?: DeliveryModel | null
  parent_account?: string | null
}

export interface SeriesStatus {
  job_number: string
  job_name: string
  metric: ForecastMetric
  status: string
  reason: string
  last_valid_month: IsoMonth | null
  n_valid: number
  delivery_model?: DeliveryModel | null
}

/** Present when `/forecasts` is called with `account=`; describes how much of the account the `__ACCOUNT__` aggregate covers. */
export interface ForecastAccountSummary {
  account: string
  sites_total: number
  sites_forecast: number
  sites_not_forecast: number
  self_perform_sites: number
  subcontracted_sites: number
  last_closed_month: IsoMonth | null
  last_closed_actual: { revenue: number; labor_cost: number; subcontract_cost: number; gross_profit: number }
  /** Share (percentage points) of last-closed revenue produced by the sites that were forecast. */
  forecast_coverage_pct: number | null
}

export interface ForecastsResponse {
  source: SourceBlock
  metric: ForecastMetric
  run: RunMeta | null
  rows: ForecastRow[]
  not_forecast: SeriesStatus[]
  account_summary?: ForecastAccountSummary | null
}

export interface ForecastHistoryRow {
  month: IsoMonth
  revenue: number
  gross_profit: number
  labor_cost: number
  /** Present when the source carries the direct-cost breakdown. */
  subcontract_cost?: number | null
  hours: number
  closed: boolean
  suspect: string | null
}

export interface ForecastHistoryResponse {
  rows: ForecastHistoryRow[]
  metric?: string
  account?: string | null
  source?: SourceBlock
}

export interface TrackRecordRow {
  volatility_class?: string | null
  origin_month: IsoMonth
  forecast_month: IsoMonth
  horizon: number
  method: string
  point: number
  lo: number
  hi: number
  actual: number | null
  scaled_error: number | null
  in_band: boolean | null
}

export interface TrackRecordResponse {
  metric: ForecastMetric
  job_number: string
  rows: TrackRecordRow[]
  run?: RunMeta | null
  source?: SourceBlock
}

/** AccuracyRow is referenced but not defined by the contract; fields mirror ForecastRow.accuracy plus identifiers. */
export interface AccuracyRow extends ForecastAccuracy {
  metric?: ForecastMetric
  horizon_step?: number
  [extra: string]: unknown
}

export interface JobForecastResponse {
  job_number: string
  job_name: string
  rows: ForecastRow[]
  accuracy: AccuracyRow[]
  /** Live rows carry {month, revenue, gross_profit, labor_cost, hours, data_quality_status}; closed/suspect may be absent. */
  history: (Partial<ForecastHistoryRow> & { month: IsoMonth })[]
  run?: RunMeta | null
  not_forecast?: SeriesStatus[]
  source?: SourceBlock
}

export interface ForecastsQuery {
  metric?: ForecastMetric
  account?: string
}

export interface TrackRecordQuery {
  metric?: ForecastMetric
  job_number?: string
}

// ---------------------------------------------------- Executive labor P&L (weekly)
// docs/api-contract.md, "Executive labor P&L (weekly), added 2026-09-03".

export type InvoicingBasis = 'job_cost_month_prorated' | 'ar_invoice_prorated' | 'contract' | 'carry_forward' | 'none'
export type BudgetBasis = 'daily_budget' | 'hbc' | 'none'
export type LaborCostBasis = 'trailing_job_rate' | 'job_cost'

export interface ExecutiveBusinessUnit {
  key: string
  name: string
  /** Hex colour the executive dashboard paints the BU with. */
  color: string
  /** Labor % of invoicing target (percentage points) and the "High" threshold. */
  target_pct: number
  high_pct: number
  /** Optional explicit ordering; when absent the view keeps the array order the API returns. */
  sort_order?: number
}

/** One week × site row. Money in USD, hours in hours; every value is already apportioned to the week. */
export interface ExecutiveLaborRow {
  /** ISO Monday of the week. */
  week: string
  bu: string
  /** Short site code shown in tables and pills (e.g. "LGB3"). */
  site: string
  job_number: string
  site_name: string
  account: string
  /** Second level under the account (live API 2026-09-04+; the account itself when it has no second level). */
  sub_account?: string
  delivery_model: DeliveryModel | null
  invoicing: number
  invoicing_basis: InvoicingBasis
  /** Live API: true when invoicing is a carried-forward estimate (basis carry_forward). */
  invoicing_estimated?: boolean
  carry_forward_source?: 'job_cost' | 'ar_invoice' | null
  hours: number
  ot_hours: number
  dt_hours: number
  budget_hours: number
  budget_dollars: number
  budget_basis: BudgetBasis
  /** Straight-time labor (hours × job rate). */
  direct_dollars: number
  /** OT premium estimate: ot_hours × rate × 0.5 + dt_hours × rate. */
  ot_dollars: number
  /** Subcontract (agency) cost apportioned to the week. */
  sub_dollars: number
  /** Live API: which source fed sub_dollars (job_cost | agency_ap | carry_forward | none). */
  sub_basis?: string
  /** True when the month is not closed and the latest closed month's rate is carried forward. */
  sub_estimated: boolean
  /** direct + ot + sub. */
  total_dollars: number
  labor_cost_basis: LaborCostBasis
  days_with_labor: number
}

export interface ExecutiveLaborPl {
  source: SourceBlock
  as_of: string | null
  /** "All" or the parent account echoed back. */
  account: string
  /** Echoed filters (live API 2026-09-04+). */
  sub_account?: string | null
  delivery?: ExecutiveDelivery
  /** Ordered ISO Mondays ending at the latest week with labor. */
  weeks: string[]
  /** Default selection: the latest week with a full 7 days of labor. */
  selected_week: string | null
  business_units: ExecutiveBusinessUnit[]
  rows: ExecutiveLaborRow[]
  /** QA scores are not in the warehouse; always null for now (typed permissively for a future shape). */
  qa: Record<string, unknown> | null
  notes: string[]
  /** Vendor cost projection and the live AP look (contract "Vendor cost: projection and live AP look", 2026-09-04+); absent on older APIs. */
  vendor?: ExecutiveVendorBlock | null
}

/** One AP vendor-type slice of the month-to-date subcontractor invoicing. */
export interface ExecutiveVendorTypeSlice { vendor_type: string; invoiced: number; invoices: number }

/** Month-to-date AP invoices for subcontractor-type vendors. Company-wide: WinTeam AP is not job-linked. */
export interface ExecutiveVendorApLive {
  invoiced_to_date: number
  invoices: number
  vendors: number
  /** ISO date the invoices run through. */
  through: string
  by_vendor_type: ExecutiveVendorTypeSlice[]
}

/** One closed month: the job-cost subcontract line next to what AP invoiced. */
export interface ExecutiveVendorHistoryMonth {
  /** ISO first of month. */
  month: string
  job_cost_sub: number
  ap_subcontractor_invoiced: number
  ap_all_invoiced: number
}

export interface ExecutiveVendorBlock {
  /** ISO first of the month the block describes (the latest month with rows). */
  month: string
  month_status: 'closed' | 'in_progress'
  as_of: string | null
  /** Projected subcontract cost for `month` (sum of the sites' trailing-3-month weekly averages × weeks). */
  projected_month_sub: number
  projected_basis: string
  sites_projected: number
  ap_live: ExecutiveVendorApLive | null
  /** Last 6 closed months, oldest first. */
  history: ExecutiveVendorHistoryMonth[]
}

/** Delivery filter (contract "Executive slicing"): `all` (default) or one delivery model. */
export type ExecutiveDelivery = 'all' | DeliveryModel

export interface ExecutiveLaborPlQuery {
  /** "All" (default) or a parent account. */
  account?: string
  /** Second level under a key account (a school district, FedEx Express/Ground); omitted = every sub-account. */
  sub_account?: string
  /** all | self_perform | subcontracted (default all). */
  delivery?: ExecutiveDelivery
  weeks?: number
  week?: string
}

/** Site counts by delivery model (contract "Executive slicing"). */
export interface ExecutiveDeliveryCounts {
  self_perform: number
  subcontracted: number
}

export interface ExecutiveSubAccount {
  name: string
  sites: number
  delivery?: ExecutiveDeliveryCounts
}

export interface ExecutiveAccount {
  name: string
  /** Display label (e.g. "FedEx (incl. FXE, FXG)"); defaults to name. */
  label?: string
  /** Contract says `sites`; typed as a count or a list of site codes (see docs/frontend.md). */
  sites: number | string[]
  business_units: string[]
  /** Second level under the account, ordered by sites desc (live API 2026-09-04+). */
  sub_accounts?: ExecutiveSubAccount[]
  delivery?: ExecutiveDeliveryCounts
}

export interface ExecutiveAccountsResponse {
  accounts: ExecutiveAccount[]
  source?: SourceBlock
}
