/**
 * Analytics suite (super administrators only): the reporting, labor and forecast routes of the
 * contract that the retired portfolio views read. The request core, the error type and the admin
 * token are the app's own (src/services/api.ts); ratio fields arrive as percentage points here,
 * as these views expect.
 */
import type {
  CompanyCamStatus,
  SiteVendorsResponse,
  AccountsResponse, AlertsResponse, ApSummary, AppSetting, ArAgingResponse, ArInvoicesQuery, ArInvoicesResponse,
  BudgetVariance, ConnectionTestResult, DimensionsResponse, ExecutiveAccountsResponse, ExecutiveLaborPl, ExecutiveLaborPlQuery, FinanceReferenceLoadResult, FinanceReferenceStatus, ForecastBuildResult, ForecastHistoryResponse, ForecastsQuery,
  ForecastMetaResponse, ForecastsResponse, FreshnessResponse, FullSyncResult, IntegrationStatus, SarusStatus, SyncOptions, JobDetailResponse, JobForecastResponse,
  JobsResponse, LaborPace, LaborPaceQuery, LaborSummary, PortfolioSummary, RebuildResult, ReportingQuery, RunMeta,
  SettingsResponse, SyncRunResult, SyncRunsResponse, SystemStatus, TimekeepingSummary, TrackRecordQuery, TrackRecordResponse, WatermarkResetResult } from '../../services/apiTypes'

import { request, type QueryParams } from '../../services/api'

export { ApiError, RATIO_FIELDS, UNAUTHORIZED_EVENT, apiBaseUrl, buildQuery, hasAdminToken, ratiosToPoints, request, setAdminToken } from '../../services/api'
export type { QueryParams, RequestOptions } from '../../services/api'

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
