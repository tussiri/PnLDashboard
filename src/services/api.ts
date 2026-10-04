import type {
  FullSyncResult, LeadershipAccount, LeadershipAccountJob, LeadershipAccountPatch, LeadershipConfig, LeadershipImportFile, LeadershipImportKind,
  LeadershipJobMapping, LeadershipRowsQuery, LeadershipRowsResponse, LeadershipSegment, LeadershipSiteResponse, LeadershipVendorsResponse, LeadershipFeedbackResponse, FeedbackOverview, LeadershipQaResponse, LeadershipBudgetResponse, BudgetPlanRow, BudgetWeekRow, LeadershipMonthlyResponse, MailInboxStatus, MailInboxSetting, MailPollResult, CompanyResponse, LeadershipMonthResponse, AllocationStatus, AllocationSettings, AllocationMonth,
  PhotoValidationSyncResult, RebuildResult, StaffingJobResponse, SyncOptions, SyncRunsResponse, SystemStatus } from './apiTypes'

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
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: QueryParams
  body?: unknown
  admin?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  /** Keep ratio fields as fractions (the leadership routes: src/leadership/metrics.ts works in fractions). */
  rawRatios?: boolean
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', query, body, admin = false, signal, timeoutMs = 20_000, rawRatios = false } = options
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
  return method === 'GET' && !rawRatios ? ratiosToPoints(payload) : payload
}

const syncQuery = (options?: SyncOptions): QueryParams => ({ ...(options?.force ? { force: true } : {}), ...(options?.deep ? { deep: true } : {}) })

/** The contract routes the app calls. Every call accepts an optional AbortSignal as the last argument. */
export const api = {
  // Platform
  systemStatus: (signal?: AbortSignal) => request<SystemStatus>('/system/status', { signal, timeoutMs: 8_000 }),
  /** On demand (the nightly and interval schedules run server-side). */
  syncAll: (options?: SyncOptions, signal?: AbortSignal) => request<FullSyncResult>('/integrations/winteam/sync', { method: 'POST', admin: true, query: syncQuery(options), signal, timeoutMs: 900_000 }),
  syncSarus: (options?: SyncOptions, signal?: AbortSignal) => request<FullSyncResult>('/integrations/winteam/sarus/sync', { method: 'POST', admin: true, query: syncQuery(options), signal, timeoutMs: 900_000 }),
  syncPhotoValidation: (signal?: AbortSignal) => request<PhotoValidationSyncResult>('/integrations/photovalidation/sync', { method: 'POST', admin: true, signal, timeoutMs: 300_000 }),
  rebuildMarts: (signal?: AbortSignal) => request<RebuildResult>('/marts/rebuild', { method: 'POST', admin: true, signal, timeoutMs: 600_000 }),
  syncRuns: (limit = 25, signal?: AbortSignal) => request<SyncRunsResponse>('/integrations/winteam/runs', { query: { limit }, signal }),
  mailStatus: (signal?: AbortSignal) => request<MailInboxStatus>('/integrations/mail', { signal, rawRatios: true }),
  updateMailSetting: (value: MailInboxSetting, signal?: AbortSignal) => request<{ value: MailInboxSetting }>('/settings/mail_inbox', { method: 'PUT', body: { value }, admin: true, signal, rawRatios: true }),
  mailPoll: (signal?: AbortSignal) => request<MailPollResult>('/integrations/mail/poll', { method: 'POST', admin: true, signal, timeoutMs: 600_000 }),
  // Leadership labor P&L (ratios stay fractions)
  leadershipConfig: (signal?: AbortSignal) => request<LeadershipConfig>('/leadership/config', { signal, rawRatios: true }),
  leadershipRows: (query?: LeadershipRowsQuery, signal?: AbortSignal) => request<LeadershipRowsResponse>('/leadership/rows', { query: { ...query }, signal, rawRatios: true }),
  leadershipSite: (company: string, jobNumber: string, query?: { week?: string; weeks?: number }, signal?: AbortSignal) =>
    request<LeadershipSiteResponse>(`/leadership/sites/${encodeURIComponent(company)}/${encodeURIComponent(jobNumber)}`, { query: { ...query }, signal, rawRatios: true }),
  // Staffing requests (analyst and admin; lines carry pay rates)
  staffingJob: (company: string, jobNumber: string, query?: { week?: string }, signal?: AbortSignal) =>
    request<StaffingJobResponse>(`/staffing/jobs/${encodeURIComponent(company)}/${encodeURIComponent(jobNumber)}`, { query: { ...query }, signal, rawRatios: true }),
  leadershipBudget: (account: string, signal?: AbortSignal) => request<LeadershipBudgetResponse>('/leadership/budget', { query: { account }, signal, rawRatios: true }),
  saveBudget: (account: string, plan: { months?: BudgetPlanRow[]; weeks?: BudgetWeekRow[] }, signal?: AbortSignal) => request<{ account: string; months: BudgetPlanRow[] }>(`/leadership/budget/${encodeURIComponent(account)}`, { method: 'PUT', body: { months: plan.months ?? [], weeks: plan.weeks ?? [] }, admin: true, signal, rawRatios: true }),
  deleteBudget: (account: string, month?: string, signal?: AbortSignal, weeks = false) => request<{ account: string; removed: number }>(`/leadership/budget/${encodeURIComponent(account)}`, { method: 'DELETE', query: weeks ? { weeks: 'true' } : month ? { month } : undefined, admin: true, signal, rawRatios: true }),
  leadershipFeedbackOverview: (account: string, month: string | undefined, signal?: AbortSignal) => request<FeedbackOverview>('/leadership/feedback/overview', { query: { account, month }, signal, rawRatios: true }),
  leadershipQa: (account: string, week: string | undefined, signal?: AbortSignal) => request<LeadershipQaResponse>('/leadership/qa', { query: { account, week, weeks: 16 }, signal, rawRatios: true }),
  leadershipFeedback: (account: string, months = 12, signal?: AbortSignal) => request<LeadershipFeedbackResponse>('/leadership/feedback', { query: { account, months }, signal, rawRatios: true }),
  leadershipVendors: (account: string, months = 6, signal?: AbortSignal) => request<LeadershipVendorsResponse>('/leadership/vendors', { query: { account, months }, signal, rawRatios: true }),
  leadershipMonthly: (account: string, months = 3, signal?: AbortSignal) => request<LeadershipMonthlyResponse>('/leadership/monthly', { query: { account, months }, signal, rawRatios: true }),
  leadershipMonth: (account: string, month: string, signal?: AbortSignal) => request<LeadershipMonthResponse>('/leadership/month', { query: { account, month }, signal, rawRatios: true }),
  leadershipCompany: (months = 14, signal?: AbortSignal) => request<CompanyResponse>('/leadership/company', { query: { months }, signal, rawRatios: true }),
  allocationStatus: (signal?: AbortSignal) => request<AllocationStatus>('/leadership/allocations', { admin: true, signal, rawRatios: true }),
  updateAllocationSettings: (settings: Partial<AllocationSettings>, signal?: AbortSignal) => request<{ settings: AllocationSettings }>('/leadership/allocations', { method: 'PUT', body: settings, admin: true, signal, rawRatios: true }),
  updateAllocationMonth: (month: string, values: { burden_rate: number | null; overhead_pool: number | null }, signal?: AbortSignal) =>
    request<{ months: AllocationMonth[] }>(`/leadership/allocations/months/${month.slice(0, 7)}`, { method: 'PUT', body: values, admin: true, signal, rawRatios: true }),
  leadershipUpdateAccount: (slug: string, patch: LeadershipAccountPatch, signal?: AbortSignal) =>
    request<LeadershipAccount>(`/leadership/accounts/${encodeURIComponent(slug)}`, { method: 'PUT', body: patch, admin: true, signal }),
  leadershipReplaceSegments: (slug: string, segments: Pick<LeadershipSegment, 'name' | 'target_labor_pct'>[], signal?: AbortSignal) =>
    request<LeadershipAccount & { jobs_moved_to_fallback: number }>(`/leadership/accounts/${encodeURIComponent(slug)}/segments`, { method: 'PUT', body: segments, admin: true, signal }),
  leadershipAccountJobs: (query?: { account?: string; needs_review?: boolean; unmapped?: boolean }, signal?: AbortSignal) =>
    request<{ jobs: LeadershipAccountJob[] }>('/leadership/account-jobs', { query: { ...query }, admin: true, signal, rawRatios: true }),
  leadershipMapJob: (company: string, jobNumber: string, mapping: LeadershipJobMapping, signal?: AbortSignal) =>
    request<LeadershipAccountJob>(`/leadership/account-jobs/${encodeURIComponent(company)}/${encodeURIComponent(jobNumber)}`, { method: 'PUT', body: mapping, admin: true, signal }),
  leadershipReloadSeed: (signal?: AbortSignal) => request<{ added: { accounts: number; segments: number; jobs: number } }>('/leadership/accounts/seed', { method: 'POST', admin: true, signal }),
  leadershipImports: (limit = 25, signal?: AbortSignal) => request<{ files: LeadershipImportFile[] }>('/leadership/imports', { query: { limit }, admin: true, signal, rawRatios: true }),
  leadershipUpload: (file: File, kind?: LeadershipImportKind, signal?: AbortSignal) => uploadImport(file, kind, signal),
  /** An uploaded labor budget workbook as one tab-separated table per sheet (nothing saved). */
  readBudgetWorkbook: (file: File, signal?: AbortSignal) => { const form = new FormData(); form.append('file', file); return postForm<{ file: string; sheets: { name: string; text: string }[] }>('/leadership/budget/read', form, signal) },
}

async function postForm<T>(path: string, form: FormData, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (adminToken) headers['X-Admin-Token'] = adminToken
  const response = await fetch(`${apiBaseUrl()}${path}`, { method: 'POST', body: form, headers, signal })
  if (!response.ok) {
    let detail = response.statusText || `HTTP ${response.status}`
    try { const payload = await response.json() as { detail?: unknown }; if (typeof payload?.detail === 'string') detail = payload.detail } catch { /* keep statusText */ }
    throw new ApiError(response.status, detail, path)
  }
  return response.json() as Promise<T>
}

/** Multipart upload of one export file (the JSON `request` helper cannot send FormData). */
async function uploadImport(file: File, kind: LeadershipImportKind | undefined, signal?: AbortSignal): Promise<{ file: LeadershipImportFile; marts: unknown }> {
  const form = new FormData()
  form.append('file', file)
  if (kind) form.append('kind', kind)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (adminToken) headers['X-Admin-Token'] = adminToken
  const response = await fetch(`${apiBaseUrl()}/leadership/imports`, { method: 'POST', body: form, headers, signal })
  if (!response.ok) {
    let detail = response.statusText || `HTTP ${response.status}`
    try { const payload = await response.json() as { detail?: unknown }; if (typeof payload?.detail === 'string') detail = payload.detail } catch { /* keep statusText */ }
    throw new ApiError(response.status, detail, '/leadership/imports')
  }
  return response.json() as Promise<{ file: LeadershipImportFile; marts: unknown }>
}

export type LiveApi = typeof api
