import type {
  CompanyCamStatus,
  SiteVendorsResponse,
  AccountsResponse, AlertsResponse, ApSummary, AppSetting, ArAgingResponse, ArInvoicesQuery, ArInvoicesResponse,
  BudgetVariance, ConnectionTestResult, DimensionsResponse, ExecutiveAccountsResponse, ExecutiveLaborPl, ExecutiveLaborPlQuery, FinanceReferenceLoadResult, FinanceReferenceStatus, ForecastBuildResult, ForecastHistoryResponse, ForecastsQuery,
  ForecastMetaResponse, ForecastsResponse, FreshnessResponse, FullSyncResult, IntegrationStatus, SarusStatus, SyncOptions, JobDetailResponse, JobForecastResponse,
  JobsResponse, LaborPace, LaborPaceQuery, LaborSummary, PortfolioSummary, RebuildResult, ReportingQuery, RunMeta,
  SettingsResponse, SyncRunResult, SyncRunsResponse, SystemStatus, TimekeepingSummary, TrackRecordQuery, TrackRecordResponse, WatermarkResetResult } from './apiTypes'

/**
 * The live API expresses ratio fields as fractions (gross_margin_pct: 0.25, pct_over: -0.046)
 * while the contract examples, the demo adapter and every view use percentage points (25.0).
 * The conversion happens once, here, by explicit field name - never by guessing from magnitude.
 */
export const RATIO_FIELDS = new Set(['gross_margin_pct', 'labor_pct_revenue', 'overtime_pct', 'revenue_pct', 'hours_pct', 'gross_margin_pts', 'labor_pct_pts', 'overtime_pct_pts', 'pct_over', 'variance_pct', 'labor_variance_pct', 'target_labor_pct'])

export function ratiosToPoints<T>(value: T, parentKey?: string): T {
  if (Array.isArray(value)) return value.map((item) => ratiosToPoints(item)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[key] = typeof inner === 'number' && RATIO_FIELDS.has(key) ? Math.round(inner * 100 * 10_000) / 10_000 : ratiosToPoints(inner, key)
    return out as T
  }
  void parentKey
  return value
}

export class ApiError extends Error {
  readonly status: number
  readonly detail: string
  readonly path: string
  constructor(status: number, detail: string, path: string) {
    super(status === 0 ? detail : `${status}: ${detail}`)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
    this.path = path
  }
  get isNetwork() { return this.status === 0 }
  get isUnauthorized() { return this.status === 401 || this.status === 403 }
}

/** Dispatched on window when a data route answers 401 (session missing or expired). */
export const UNAUTHORIZED_EVENT = 'crane-ifs:unauthorized'

/** Admin token lives only in memory for the lifetime of the tab. It is never persisted. */
let adminToken: string | null = null
export const setAdminToken = (token: string | null) => { adminToken = token && token.trim() ? token.trim() : null }
export const hasAdminToken = () => adminToken !== null

export const apiBaseUrl = (): string => (import.meta.env.VITE_API_BASE_URL as string | undefined) || '/api/v1'

export type QueryParams = Record<string, string | number | boolean | undefined | null>

export function buildQuery(params?: QueryParams): string {
  if (!params) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT'
  query?: QueryParams
  body?: unknown
  admin?: boolean
  signal?: AbortSignal
  timeoutMs?: number
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', query, body, admin = false, signal, timeoutMs = 20_000 } = options
  const url = `${apiBaseUrl()}${path}${buildQuery(query)}`
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  // Protected operations accept either the token or an admin session; without a token the API decides.
  if (admin && adminToken) headers['X-Admin-Token'] = adminToken
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal })
  } catch (error) {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (signal?.aborted) throw error
    const detail = controller.signal.aborted ? `Request timed out after ${Math.round(timeoutMs / 1000)}s` : (error instanceof Error ? error.message : 'Network error')
    throw new ApiError(0, detail, path)
  }
  clearTimeout(timer)
  signal?.removeEventListener('abort', onAbort)
  if (!response.ok) {
    let detail = response.statusText || `HTTP ${response.status}`
    try {
      const payload = await response.json() as { detail?: unknown }
      if (typeof payload?.detail === 'string') detail = payload.detail
      else if (payload?.detail) detail = JSON.stringify(payload.detail)
    } catch { /* keep statusText */ }
    // A 401 on a data route means the session cookie is gone or expired: the shell returns to the login page.
    if (response.status === 401 && !path.startsWith('/auth/') && !admin && typeof window !== 'undefined') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
    throw new ApiError(response.status, detail, path)
  }
  if (response.status === 204) return undefined as T
  const payload = await response.json() as T
  return method === 'GET' ? ratiosToPoints(payload) : payload
}

const reporting = (query?: ReportingQuery): QueryParams => ({ ...query })
const syncQuery = (options?: SyncOptions): QueryParams => ({ ...(options?.force ? { force: true } : {}), ...(options?.deep ? { deep: true } : {}) })

/** One function per contract route. Every call accepts an optional AbortSignal as the last argument. */
export const api = {
  // Platform
  systemStatus: (signal?: AbortSignal) => request<SystemStatus>('/system/status', { signal, timeoutMs: 8_000 }),
  integrationStatus: (signal?: AbortSignal) => request<IntegrationStatus>('/integrations/winteam', { signal }),
  testConnection: (signal?: AbortSignal) => request<ConnectionTestResult>('/integrations/winteam/test', { method: 'POST', admin: true, signal, timeoutMs: 60_000 }),
  resetWatermark: (resource: string, signal?: AbortSignal) => request<WatermarkResetResult>(`/integrations/winteam/watermark/${encodeURIComponent(resource)}/reset`, { method: 'POST', admin: true, signal }),
  syncResource: (resource: string, signal?: AbortSignal) => request<SyncRunResult>(`/integrations/winteam/sync/${encodeURIComponent(resource)}`, { method: 'POST', admin: true, signal, timeoutMs: 600_000 }),
  /** On demand only: nothing syncs WinTeam on a schedule. */
  syncAll: (options?: SyncOptions, signal?: AbortSignal) => request<FullSyncResult>('/integrations/winteam/sync', { method: 'POST', admin: true, query: syncQuery(options), signal, timeoutMs: 900_000 }),
  sarusStatus: (signal?: AbortSignal) => request<SarusStatus>('/integrations/winteam/sarus', { signal }),
  syncSarus: (options?: SyncOptions, signal?: AbortSignal) => request<FullSyncResult>('/integrations/winteam/sarus/sync', { method: 'POST', admin: true, query: syncQuery(options), signal, timeoutMs: 900_000 }),
  rebuildMarts: (signal?: AbortSignal) => request<RebuildResult>('/marts/rebuild', { method: 'POST', admin: true, signal, timeoutMs: 600_000 }),
  rebuildForecasts: (signal?: AbortSignal) => request<ForecastBuildResult>('/forecasts/rebuild', { method: 'POST', admin: true, signal, timeoutMs: 600_000 }),
  financeReference: (signal?: AbortSignal) => request<FinanceReferenceStatus>('/integrations/finance-reference', { signal }),
  /** Full replace of the warehouse from the finance_reference database; long-running (contract: minutes), hence the 900 s timeout. */
  loadFinanceReference: (signal?: AbortSignal) => request<FinanceReferenceLoadResult>('/integrations/finance-reference/load', { method: 'POST', admin: true, signal, timeoutMs: 900_000 }),
  syncRuns: (limit = 25, signal?: AbortSignal) => request<SyncRunsResponse>('/integrations/winteam/runs', { query: { limit }, signal }),
  freshness: (signal?: AbortSignal) => request<FreshnessResponse>('/data/freshness', { signal }),
  settings: (signal?: AbortSignal) => request<SettingsResponse>('/settings', { signal }),
  updateSetting: (key: string, value: AppSetting['value'], signal?: AbortSignal) => request<AppSetting>(`/settings/${encodeURIComponent(key)}`, { method: 'PUT', body: { value }, admin: true, signal }),
  dimensions: (signal?: AbortSignal) => request<DimensionsResponse>('/dimensions', { signal }),
  // Reporting
  portfolioSummary: (query?: ReportingQuery, signal?: AbortSignal) => request<PortfolioSummary>('/portfolio/summary', { query: reporting(query), signal }),
  jobs: (query?: ReportingQuery, signal?: AbortSignal) => request<JobsResponse>('/jobs', { query: reporting(query), signal }),
  job: (jobNumber: string, months = 24, signal?: AbortSignal) => request<JobDetailResponse>(`/jobs/${encodeURIComponent(jobNumber)}`, { query: { months }, signal }),
  siteVendors: (jobNumber: string, months = 12, signal?: AbortSignal) =>
    request<SiteVendorsResponse>(`/jobs/${encodeURIComponent(jobNumber)}/subcontractors`, { query: { months }, signal }),
  companycam: (signal?: AbortSignal) => request<CompanyCamStatus>('/integrations/companycam', { signal }),
  accounts: (query?: ReportingQuery, signal?: AbortSignal) => request<AccountsResponse>('/accounts', { query: reporting(query), signal }),
  arAging: (query?: ReportingQuery, signal?: AbortSignal) => request<ArAgingResponse>('/ar/aging', { query: reporting(query), signal }),
  arInvoices: (query?: ArInvoicesQuery, signal?: AbortSignal) => request<ArInvoicesResponse>('/ar/invoices', { query: { ...query }, signal }),
  apSummary: (query?: ReportingQuery, signal?: AbortSignal) => request<ApSummary>('/ap/summary', { query: reporting(query), signal }),
  laborSummary: (query?: ReportingQuery, signal?: AbortSignal) => request<LaborSummary>('/labor/summary', { query: reporting(query), signal }),
  laborPace: (query?: LaborPaceQuery, signal?: AbortSignal) => request<LaborPace>('/labor/pace', { query: { ...query }, signal }),
  timekeepingSummary: (query?: ReportingQuery, signal?: AbortSignal) => request<TimekeepingSummary>('/timekeeping/summary', { query: reporting(query), signal }),
  budgetVariance: (query?: ReportingQuery, signal?: AbortSignal) => request<BudgetVariance>('/budget/variance', { query: reporting(query), signal }),
  alerts: (query?: ReportingQuery, signal?: AbortSignal) => request<AlertsResponse>('/alerts', { query: reporting(query), signal }),
  // Forecasting
  forecasts: (query?: ForecastsQuery, signal?: AbortSignal) => request<ForecastsResponse>('/forecasts', { query: { ...query }, signal }),
  forecastMeta: async (signal?: AbortSignal): Promise<ForecastMetaResponse> => {
    const payload = await request<ForecastMetaResponse | RunMeta | null>('/forecasts/meta', { signal })
    if (payload && typeof payload === 'object' && 'run' in payload) return payload as ForecastMetaResponse
    return { run: (payload as RunMeta | null) ?? null }
  },
  forecastHistory: (query?: ForecastsQuery, signal?: AbortSignal) => request<ForecastHistoryResponse>('/forecasts/history', { query: { ...query }, signal }),
  forecastTrackRecord: (query?: TrackRecordQuery, signal?: AbortSignal) => request<TrackRecordResponse>('/forecasts/track-record', { query: { ...query }, signal }),
  forecastJob: (jobNumber: string, signal?: AbortSignal) => request<JobForecastResponse>(`/forecasts/${encodeURIComponent(jobNumber)}`, { signal }),
  // Executive labor P&L (weekly)
  executiveLaborPl: (query?: ExecutiveLaborPlQuery, signal?: AbortSignal) => request<ExecutiveLaborPl>('/executive/labor-pl', { query: { ...query }, signal }),
  executiveAccounts: (signal?: AbortSignal) => request<ExecutiveAccountsResponse>('/executive/accounts', { signal }),
}

export type LiveApi = typeof api
