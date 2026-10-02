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
  /** The worker's light timekeeping sync interval in seconds (WINTEAM_SYNC_INTERVAL_MINUTES); null when it is off. */
  poll_seconds: number | null
  /** 'scheduled' while the light interval sync is on, else 'on_demand' (nightly and Admin syncs run either way). */
  sync?: SyncMode
  normalize_enabled?: boolean
}

export type SyncMode = 'on_demand' | 'scheduled'

/** GET /integrations/winteam/sarus - the second WinTeam database. Never carries the tenant id or key. */
export interface SarusStatus {
  configured: boolean
  enabled: boolean
  base_url_host: string | null
  has_subscription_key: boolean
  ingestion: boolean
  sync?: SyncMode
  resources: IntegrationResource[]
  precedence: {
    sarus_timekeeping_from: string | null
    sarus_timekeeping_to: string | null
    sarus_ap_invoice_from: string | null
    sarus_ap_invoice_to: string | null
    sarus_ar_invoices_api: number
  }
}

/** Options of an on-demand sync. force: also re-read the daily resources synced within 20 hours;
 *  deep: re-read 35 days of timekeeping and AP instead of 3. */
export interface SyncOptions { force?: boolean; deep?: boolean }

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
  /** null for a skipped resource (no run was started). */
  run_id: string | number | null
  resource: string
  /** 'succeeded' | 'failed' | 'skipped' (a daily resource synced within the last 20 hours). */
  status: string
  fetched: number
  inserted: number
  normalized: number | null
  message?: string
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
  /** null when nothing was normalized (every resource skipped, or normalize=false). */
  marts: RebuildResult | null
  normalized?: boolean
  not_entitled?: string[]
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

/** One mail rule: each non-empty list must match; exclude_subjects refuses a subject containing any. */
export interface MailRule { name: string; senders: string[]; subjects: string[]; exclude_subjects: string[]; files: string[] }
/** ops.app_setting 'mail_inbox' (PUT /settings/mail_inbox). Mail matching any rule is the dashboard's; no rules = all mail. */
export interface MailInboxSetting { enabled: boolean; every_minutes: number; first_lookback_days: number; rules: MailRule[] }
/** GET /integrations/mail: the reports mailbox poller. */
export interface MailInboxStatus {
  configured: boolean
  mailbox: string | null
  schedule: MailInboxSetting
  last_run: { status: string; started_at: string; completed_at: string | null; records_inserted: number | null; error_message: string | null } | null
  recent: {
    received_at: string; sender: string | null; subject: string | null; file_name: string
    status: 'loaded' | 'duplicate' | 'failed' | 'ignored'; reason: string | null; kind: string | null; rows_loaded: number | null
  }[]
}
export interface MailPollResult { status: 'succeeded' | 'failed'; error?: string; loaded?: number; duplicate?: number; failed?: number; ignored?: number; messages?: number; rebuilt?: boolean }

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
  /** False when the finance_reference export is stale. A failed WinTeam sync is recorded as failed, so nothing is overdue. */
  healthy: boolean
  overdue_resources: string[]
  overdue_after_seconds: number | null
  poll_seconds: number | null
  sync?: SyncMode
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
  /** PhotoValidation headcount approved or posted at the end of the week; null before the feed loads. */
  requested_headcount?: number | null
  /** PhotoValidation headcount awaiting a decision at the end of the week; null before the feed loads. */
  pending_requested_headcount?: number | null
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

// Leadership labor P&L (contract "Leadership labor P&L", added 2026-09-23)
// Ratios in these payloads stay fractions (target_labor_pct: 0.645); the client does not convert them.

/** pallet: a WinTeam child job ("... Pallet") rolled into its parent site. */
export type LeadershipRole = 'site' | 'catch_all' | 'non_billed' | 'pallet'
export type LeadershipLaborBasis = 'pay_report' | 'payroll_rate' | 'trailing_rate_estimate'
export type LeadershipRevenueMethod = 'monthly_div' | 'weekly_billing' | 'per_visit'
export type LeadershipSegmentSource = 'explicit' | 'sub_account' | 'company' | 'fallback'

export interface LeadershipSegment {
  name: string
  sort: number
  /** Overrides the account target for this segment; null = the account target. */
  target_labor_pct: number | null
}

export interface LeadershipAccount {
  slug: string
  name: string
  featured: boolean
  sort: number
  target_labor_pct: number
  watch_band: number
  revenue_method: LeadershipRevenueMethod
  revenue_divisor: number
  budget_reliability_ratio: number
  source_parent_accounts: string[]
  segment_source: LeadershipSegmentSource
  fallback_segment: string
  /** budget_hours: a parent job's billing is spread over its child sites by budget hours. */
  revenue_allocation: 'none' | 'budget_hours'
  /** labor: labor % (the reference); labor_plus_vendor: cost % = (labor + vendor) / invoice. */
  cost_basis: 'labor' | 'labor_plus_vendor'
  /** What the account's groups are called ("BU" for Amazon, "Segment" by default). */
  segment_label: string
  /** What the non-payroll labor cost is called ("Agency sub", "Subcontractor", "Vendor"). */
  vendor_label: string
  /** Which weekly report's words the account's pages use. */
  vocabulary: 'amazon' | 'fedex'
  /** Share of agency or subcontractor cost counted in labor (both weekly reports: 0.70). */
  vendor_factor: number
  /** Weekly invoice from the last closed month, or the 3-month run rate. */
  invoice_basis: 'last_month' | 'run_rate_3m'
  /** Groups by segment, or Pallet sites vs Janitorial only. */
  group_by: 'segment' | 'pallet'
  /** Subcontracted sites leave the labor views for the Subcontracted Sites tab. */
  split_subcontracted: boolean
  segments: LeadershipSegment[]
  sites: number
  needs_review: number
  updated_at: string
  updated_by: string | null
}

export interface LeadershipWeek {
  week_start: string
  week_end: string
  days_with_labor: number
  /** Share of the week's labor dollars that come from the pay report; null when none do. */
  pay_report_share: number | null
  revenue_month: string | null
  in_progress: boolean
}

export interface LeadershipStatus {
  rebuilt_at: string | null
  leadership_rebuilt_at: string | null
  syncs: { integration_name: string; status: string; completed_at: string | null; started_at: string }[]
  imports: Partial<Record<LeadershipImportKind, { kind: LeadershipImportKind; file_name: string; status: string; period_from: string | null; period_to: string | null; rows_loaded: number; loaded_at: string }>>
  pay_report_through: { company: string; through: string }[]
}

export interface LeadershipConfig {
  source?: SourceBlock
  accounts: LeadershipAccount[]
  weeks: LeadershipWeek[]
  default_week: string | null
  status: LeadershipStatus
}

/** One job for one Monday week (mart.leadership_week joined with the account mapping). */
export interface LeadershipRow {
  week_start: string
  week_end: string
  company: string | null
  job_number: string
  site_name: string
  parent_account: string | null
  /** null = Other. */
  account_slug: string | null
  segment: string | null
  role: LeadershipRole
  needs_review: boolean
  hours: number
  ot_hours: number
  labor: number
  labor_basis: LeadershipLaborBasis
  /** Full overtime pay (1.5x). */
  ot_dollars: number
  budget_hours: number
  budget_dollars: number
  employees: number
  days_with_labor: number
  revenue_month: string | null
  revenue_month_amount: number
  /** Revenue moved onto (+) or off (-) this row by the account's parent-job allocation. */
  revenue_allocated: number
  /** Weight used to spread parent-billed revenue: revenue-month budget hours, else actual hours, else this week's hours. */
  allocation_weight?: 'budget_hours' | 'actual_hours' | 'week_hours' | null
  revenue_month_basis: string | null
  invoice_week: number | null
  prior_revenue: number
  prior_labor: number
  prior_labor_basis: 'pay_report' | 'job_cost' | null
  prior_sub: number
  prior_sub_basis: 'job_cost' | 'ap_distribution' | null
  delivery_model: 'self_perform' | 'subcontracted' | null
  /** Vendor cost for the week (shown beside labor for subcontracted sites, never inside labor %). */
  sub_week: number
  sub_week_basis: string | null
  consumables_cost: number | null
  consumables_basis: 'actual' | 'estimate' | null
  latitude: number | null
  longitude: number | null
  city: string | null
  state_province: string | null
  parent_job_number?: string | null
  /** Double-time hours; already inside ot_hours. */
  dt_hours?: number
  /** Average monthly revenue over the revenue month and the two before it. */
  revenue_run_rate?: number | null
  /** Average monthly variable (OS, pallet) revenue over the same months, when the Job Cost Analysis carries it. */
  variable_run_rate?: number | null
  revenue_month_variable?: number | null
  /** Month rollup only (GET /leadership/month): a subcontracted station with a contract, whether its
   * sub invoices for the month are in, and the month's AR invoices. */
  sub_expected?: boolean
  sub_received?: boolean
  ar_invoices?: number
  /** Corporate allocations for the week (app/allocations.py): management wages, payroll burden, overhead. */
  alloc_management?: number
  alloc_burden?: number
  alloc_overhead?: number
  /** Set in the browser (data.ts prepareRows): pallet jobs rolled into this site and their share. */
  kids?: string[]
  pallet_labor?: number
  pallet_hours?: number
  pallet_ot_hours?: number
}

/** GET /leadership/company: company health by month. */
export interface CompanyMoney { revenue: number; direct_labor: number; management_wages: number; subcontractors: number; payroll_taxes: number; gross_profit: number }
export interface CompanyMonth extends CompanyMoney {
  month: string
  closed: boolean
  timekeeping_labor: number
  by_company: Record<string, CompanyMoney>
  by_account: Record<string, CompanyMoney>
  statement: Record<string, number>
  allocations: { management_wages: number; burden: number; overhead: number; burden_rate: number | null; burden_source: string | null; overhead_source: string | null }
  flags: ('sub_spike' | 'labor_spike')[]
}
export interface CompanyResponse { months: CompanyMonth[]; accounts: { slug: string; name: string; featured: boolean; target_labor_pct: number }[] }

/** Admin > Allocations. */
export interface AllocationSettings {
  management_wages: { enabled: boolean }
  burden: { enabled: boolean; lines: string[] }
  overhead: { enabled: boolean; lines: string[]; basis: 'revenue' | 'labor' | 'hours' }
}
export interface AllocationMonth {
  month: string
  burden_rate: number | null
  burden_source: string | null
  overhead_pool: number | null
  overhead_source: string | null
  management_wages: number | null
  manual_burden_rate: number | null
  manual_overhead_pool: number | null
  statement_loaded: boolean
}
export interface AllocationStatus { settings: AllocationSettings; months: AllocationMonth[] }

/** One job-month for GET /leadership/monthly. */
export interface LeadershipMonth {
  revenue: number
  revenue_variable: number | null
  direct_labor: number
  payroll_taxes: number
  subcontractors: number
  relay_ar: number
  relay_ap: number
  /** Weekly timekeeping labor in the month (weeks by their Thursday). */
  timekeeping_labor: number
}

export interface LeadershipMonthlyJob {
  company: string
  job_number: string
  job_name: string | null
  role: LeadershipRole
  parent_job_number: string | null
  delivery_model: 'self_perform' | 'subcontracted' | null
  /** Keyed by the first of the month (YYYY-MM-01). */
  months: Record<string, LeadershipMonth>
}

export interface LeadershipMonthlyResponse {
  account: string
  months: string[]
  jobs: LeadershipMonthlyJob[]
  /** Trend Income Statement lines per month (revenue, revenue_subcontracted_gl, wages, payroll_taxes, subcontractors, supplies, vehicle, travel, insurance, gross_profit, ...). */
  income_statement: Record<string, Record<string, number>>
}

export interface LeadershipMonthResponse { source?: SourceBlock; month: string; account: string; rows: LeadershipRow[] }

export interface LeadershipRowsQuery {
  /** Any date in the week; defaults to the latest complete week. */
  week?: string
  weeks?: number
  /** An account slug, or featured | other | all. */
  account?: string
}

export interface LeadershipRowsResponse {
  source?: SourceBlock
  week: string | null
  weeks: string[]
  account: string
  rows: LeadershipRow[]
}

export interface LeadershipInvoiceLine {
  invoice_number: string
  invoice_date: string
  gl_account_number: string | null
  amount: number
  vendor_number: number
  vendor_name: string
  vendor_type_id: number | null
  /** winteam: a posted AP GL distribution; relay: a FedEx payable from Relay not yet among them. */
  source?: 'winteam' | 'relay'
  service_month?: string | null
  status?: string | null
  in_winteam?: boolean
  payment_status?: string | null
}

export interface LeadershipPhoto {
  id: string | number | null
  captured_at: number | string | null
  thumbnail: string | null
  web: string | null
  creator_name: string | null
}

export interface LeadershipSiteResponse {
  source?: SourceBlock
  site: {
    company: string
    job_number: string
    site_name: string
    address_line_1: string | null
    city: string | null
    state_province: string | null
    postal_code: string | null
    latitude: number | null
    longitude: number | null
    parent_job_number: string | null
    delivery_model: string | null
    parent_account: string | null
    account_slug: string | null
    segment: string | null
    role: LeadershipRole
    companycam_project_id: string | null
  }
  weeks: LeadershipRow[]
  /** Null when the user lacks the data.invoices / data.photos permission. */
  invoices: { since: string; vendor_type_ids: string[]; total: number; lines: LeadershipInvoiceLine[] } | null
  photos: { configured: boolean; project_id: string | null; items: LeadershipPhoto[] | null; error: string | null } | null
}

export interface LeadershipVendorsResponse {
  account: string
  since: string
  vendor_type_ids: string[]
  total: number
  by_vendor: { vendor_number: number; vendor_name: string; amount: number; invoices: number }[]
  by_site: { company: string; job_number: string; site_name: string; amount: number; invoices: number }[]
  by_month: { month: string; amount: number; invoices: number }[]
  lines: (LeadershipInvoiceLine & { company: string; job_number: string; site_name: string })[]
}

export type LeadershipImportKind = 'pay_report' | 'job_cost' | 'income_statement'

export interface LeadershipImportFile {
  import_file_id: number
  kind: LeadershipImportKind
  file_name: string
  origin: 'upload' | 'inbox'
  status: 'loaded' | 'failed' | 'duplicate'
  rows_read: number
  rows_loaded: number
  companies: string[]
  period_from: string | null
  period_to: string | null
  errors: string[]
  uploaded_by: string | null
  loaded_at: string
}

export interface LeadershipAccountJob {
  company: string
  job_number: string
  account_slug: string | null
  segment: string | null
  role: LeadershipRole
  companycam_project_id: string | null
  assigned_by: 'seed' | 'auto' | 'admin'
  needs_review: boolean
  job_name: string | null
  parent_account: string | null
  is_active: boolean | null
}

export type LeadershipAccountPatch = Partial<Pick<LeadershipAccount, 'name' | 'featured' | 'sort' | 'target_labor_pct' | 'watch_band' | 'revenue_method' | 'revenue_divisor' | 'budget_reliability_ratio' | 'source_parent_accounts' | 'segment_source' | 'fallback_segment' | 'revenue_allocation' | 'cost_basis' | 'segment_label' | 'vendor_label' | 'vocabulary' | 'vendor_factor' | 'invoice_basis' | 'group_by' | 'split_subcontracted'>>
export interface LeadershipJobMapping { account_slug: string | null; segment?: string | null; role?: LeadershipRole; companycam_project_id?: string | null }

// Staffing requests (PhotoValidation Contract B), added 2026-09-29
export type StaffingShift = 'day' | 'swing' | 'night' | 'weekend' | 'other'
export type StaffingStatus = 'submitted' | 'approved' | 'posted' | 'filled' | 'rejected' | 'cancelled'

/** One PhotoValidation request line held in core.fact_staffing_request. */
export interface StaffingRequestLine {
  line_id: string
  request_id: string
  request_code: string | null
  site_name: string | null
  role: string | null
  shift: StaffingShift | string | null
  shift_start: string | null
  shift_end: string | null
  headcount_needed: number
  current_filled: number | null
  reason: string | null
  employment_type: 'full_time' | 'part_time' | string | null
  hours_per_week: number | null
  /** Requested hourly rate, USD. */
  pay_rate: number | null
  needed_by: string | null
  status: StaffingStatus | string
  hire_job_id: string | null
  reported_headcount: number | null
  submitted_at: string | null
  decided_at: string | null
  posted_at: string | null
  filled_at: string | null
  closed_at: string | null
  updated_at: string
  /** Whole days from submission to fill or close; to now while open. */
  days_open: number | null
}

/** GET /staffing/jobs/{company}/{job_number}?week= (analyst and admin). */
export interface StaffingJobResponse {
  source?: SourceBlock
  /** PHOTOVALIDATION_API_URL and PHOTOVALIDATION_API_TOKEN are set. */
  configured: boolean
  /** Completion time of the last successful pull. */
  as_of: string | null
  /** Monday of the week the headcounts are read for. */
  week: string
  /** Approved or posted at the end of the week (now for the week in progress); null before the feed loads. */
  requested_headcount: number | null
  /** Submitted and undecided at the same moment; null before the feed loads. */
  pending_requested_headcount: number | null
  lines: StaffingRequestLine[]
}

/** GET /integrations/photovalidation */
export interface PhotoValidationStatus {
  configured: boolean
  base_url_host: string | null
  interval_minutes: number | null
  watermark: string | null
  lines: number
  mapped_lines: number
  open_lines: number
  last_run: { status: string; started_at: string; completed_at: string | null; records_fetched: number; records_inserted: number; error_message: string | null } | null
}

/** POST /integrations/photovalidation/sync (admin) */
export interface PhotoValidationSyncResult {
  run_id: string
  status: 'succeeded' | 'failed'
  since: string | null
  fetched: number
  loaded: number
  rejected: number
  job_keys_changed?: number
  job_week_rows_changed?: number
  error?: string
}
