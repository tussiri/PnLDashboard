import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAuth } from '../auth/useAuth'
import { useApiQuery } from '../hooks/useApiQuery'
import type { DimensionsResponse, RangeBlock, ReportingQuery, SourceBlock, SystemStatus } from '../services/apiTypes'
import { apiFor, decideMode, detectMode, type DashboardApi, type DataMode, type ModeDecision } from '../services/dataSource'
import { PERIODS, resolveRange } from '../services/period'
import { queryClient, queryKey } from '../services/queryClient'
import { defaultFilters, type DeliveryFilter, type GlobalFilters, type PageKey, type Period, type ScopeMode, type ServiceType } from '../types'

export type ToastKind = 'info' | 'success' | 'error'
export interface Toast { id: number; kind: ToastKind; title: string; detail?: string }

export interface DashboardContextValue {
  ready: boolean
  mode: DataMode
  decision: ModeDecision
  api: DashboardApi
  /** Latest /system/status (refreshed periodically in live mode). */
  systemStatus: SystemStatus | null
  refreshStatus: () => void
  /** Re-run startup detection (GET /system/status) - used after admin loads that can turn empty marts into live data. */
  redetectMode: () => Promise<void>
  filters: GlobalFilters
  setFilters: (next: GlobalFilters | ((current: GlobalFilters) => GlobalFilters)) => void
  resetFilters: () => void
  /** Filters translated to contract query params (empty strings dropped). */
  query: ReportingQuery
  dimensions: DimensionsResponse | undefined
  dimensionsError: unknown
  latestMonth: string | null
  /** The month the reporting endpoints will anchor on (explicit or the server default = latest closed month). */
  anchorMonth: string | null
  /** Range resolved client-side from period + anchor (mirrors the server rule); replaced by response.range when a view reports it. */
  resolvedRange: RangeBlock | null
  reportRange: (range: RangeBlock | undefined) => void
  /** Latest `source` block seen on any reporting payload (as_of, synced_at, latest_month, stale). */
  lastSource: SourceBlock | null
  reportSource: (source: SourceBlock | undefined) => void
  verticalLabels: Record<ServiceType, string>
  setVerticalLabels: (labels: Record<ServiceType, string>) => void
  page: PageKey
  jobNumber: string | null
  navigate: (page: PageKey) => void
  openJob: (jobNumber: string) => void
  toasts: Toast[]
  toast: (kind: ToastKind, title: string, detail?: string) => void
  dismissToast: (id: number) => void
}

const DashboardContext = createContext<DashboardContextValue | null>(null)

const storageKey = (suffix: string) => `northstar-facilities-${suffix}`
export const defaultVerticalLabels: Record<ServiceType, string> = { Janitorial: 'Commercial Janitorial', Industrial: 'Industrial Services', Healthcare: 'Healthcare Facilities', Education: 'Education Campuses' }

function readJson<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? { ...fallback, ...JSON.parse(raw) } : fallback } catch { return fallback }
}

/** Current filter storage key. v2 held the pre-scope shape (account-only, defaulting to all accounts). */
export const FILTERS_STORAGE_KEY = storageKey('filters-v3')
export const FILTERS_STORAGE_KEY_V2 = storageKey('filters-v2')

const SCOPES: ScopeMode[] = ['key', 'all', 'other']
const DELIVERIES: DeliveryFilter[] = ['all', 'self_perform', 'subcontracted']
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Coerce any stored/parsed object into a complete, valid GlobalFilters. */
export function normalizeFilters(stored: Record<string, unknown>): GlobalFilters {
  const account = text(stored.account)
  return {
    period: PERIODS.includes(stored.period as Period) ? (stored.period as Period) : defaultFilters.period,
    month: typeof stored.month === 'string' && stored.month ? stored.month : null,
    scope: SCOPES.includes(stored.scope as ScopeMode) ? (stored.scope as ScopeMode) : defaultFilters.scope,
    account,
    // A sub-account without an account is meaningless (the API answers 422).
    subAccount: account ? text(stored.subAccount) : '',
    delivery: DELIVERIES.includes(stored.delivery as DeliveryFilter) ? (stored.delivery as DeliveryFilter) : defaultFilters.delivery,
    region: text(stored.region), branch: text(stored.branch), serviceType: text(stored.serviceType), vertical: text(stored.vertical), company: text(stored.company),
  }
}

/**
 * Read the persisted filters, migrating a v2 value once: its `account` becomes the account
 * drill-down and `scope` starts at the default ('key') because v2 had no scope concept.
 */
export function migrateStoredFilters(v3Raw: string | null, v2Raw: string | null): GlobalFilters {
  const parse = (raw: string | null): Record<string, unknown> | null => {
    try { const value = raw ? JSON.parse(raw) as unknown : null; return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null } catch { return null }
  }
  const current = parse(v3Raw)
  if (current) return normalizeFilters(current)
  const legacy = parse(v2Raw)
  if (!legacy) return defaultFilters
  return normalizeFilters({ ...legacy, scope: defaultFilters.scope, subAccount: '', delivery: defaultFilters.delivery })
}

function readStoredFilters(): GlobalFilters {
  try { return migrateStoredFilters(localStorage.getItem(FILTERS_STORAGE_KEY), localStorage.getItem(FILTERS_STORAGE_KEY_V2)) } catch { return defaultFilters }
}

/**
 * Filters to contract query params. `scope` is sent only when no account is selected (the API
 * ignores it otherwise), `sub_account` only alongside an account (422 without one), and the
 * default `delivery: 'all'` is omitted.
 */
export function filtersToQuery(filters: GlobalFilters): ReportingQuery {
  const account = filters.account || undefined
  return {
    period: filters.period,
    month: filters.month ?? undefined,
    scope: account ? undefined : filters.scope,
    account,
    sub_account: account ? (filters.subAccount || undefined) : undefined,
    delivery: filters.delivery === 'all' ? undefined : filters.delivery,
    region: filters.region || undefined,
    branch: filters.branch || undefined,
    service_type: filters.serviceType || undefined,
    vertical: filters.vertical || undefined,
    company: filters.company || undefined,
  }
}

export interface DashboardProviderProps {
  children: ReactNode
  page: PageKey
  jobNumber: string | null
  navigate: (page: PageKey) => void
  openJob: (jobNumber: string) => void
  /** Test hook: skip network detection and force a mode. */
  forcedDecision?: ModeDecision
}

export function DashboardProvider({ children, page, jobNumber, navigate, openJob, forcedDecision }: DashboardProviderProps) {
  const [decision, setDecision] = useState<ModeDecision | null>(forcedDecision ?? null)
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(forcedDecision?.status ?? null)
  const [filters, setFiltersState] = useState<GlobalFilters>(readStoredFilters)
  const [verticalLabels, setVerticalLabelsState] = useState<Record<ServiceType, string>>(() => readJson(storageKey('verticals'), defaultVerticalLabels))
  const [reportedRange, setReportedRange] = useState<RangeBlock | null>(null)
  const [lastSource, setLastSource] = useState<SourceBlock | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(0)
  // No data request leaves the browser without a session: /system/status, /dimensions and every view query are gated on the signed-in user.
  const { user } = useAuth()
  const signedIn = user !== null

  useEffect(() => {
    if (forcedDecision || !signedIn) return
    const controller = new AbortController()
    detectMode(controller.signal).then((result) => { setDecision(result); setSystemStatus(result.status) }).catch(() => { /* aborted */ })
    return () => controller.abort()
  }, [forcedDecision, signedIn])

  const mode: DataMode = decision?.mode ?? 'demo'
  const api = useMemo(() => apiFor(mode), [mode])

  // Periodic status refresh in live mode keeps the data-status pill honest.
  const refreshStatus = useCallback(() => {
    if (mode !== 'live' || !signedIn) return
    api.systemStatus().then((status) => { setSystemStatus(status); if ((status.marts?.job_month_rows ?? 0) === 0) setDecision(decideMode(status)) }).catch(() => setSystemStatus((current) => (current ? { ...current, database: 'unreachable' } : current)))
  }, [api, mode, signedIn])
  useEffect(() => {
    if (mode !== 'live' || !signedIn) return
    const timer = window.setInterval(refreshStatus, 60_000)
    return () => window.clearInterval(timer)
  }, [mode, refreshStatus, signedIn])
  const redetectMode = useCallback(async () => {
    if (forcedDecision || !signedIn) return
    const result = await detectMode()
    setDecision(result); setSystemStatus(result.status)
  }, [forcedDecision, signedIn])

  useEffect(() => { localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters)) }, [filters])
  useEffect(() => { localStorage.setItem(storageKey('verticals'), JSON.stringify(verticalLabels)) }, [verticalLabels])

  const dimensionsQuery = useApiQuery(decision && signedIn ? queryKey(`${mode}/dimensions`) : null, (signal) => api.dimensions(signal), [api])
  const dimensions = dimensionsQuery.data
  // Server default anchor is the latest CLOSED month; fall back to latest_closed_month, then latest_month.
  const latestMonth = dimensions?.default_month ?? dimensions?.latest_closed_month ?? dimensions?.latest_month ?? systemStatus?.marts?.latest_month ?? null

  // Drop a persisted anchor month the current source does not know about.
  useEffect(() => {
    if (dimensions && filters.month && !dimensions.months.includes(filters.month)) setFiltersState((current) => ({ ...current, month: null }))
  }, [dimensions, filters.month])
  // A persisted company filter from another source would silently zero every view; clear it when the source has no such company.
  useEffect(() => {
    if (dimensions && filters.company && !(dimensions.companies ?? []).includes(filters.company)) setFiltersState((current) => ({ ...current, company: '' }))
  }, [dimensions, filters.company])
  // A sub-account only exists under its key account: drop it when the account changed or the source does not know it.
  useEffect(() => {
    if (!filters.subAccount) return
    if (!filters.account) { setFiltersState((current) => ({ ...current, subAccount: '' })); return }
    const known = dimensions?.key_accounts?.find((a) => a.name === filters.account)
    if (dimensions && known && !known.sub_accounts.some((s) => s.name === filters.subAccount)) setFiltersState((current) => ({ ...current, subAccount: '' }))
  }, [dimensions, filters.account, filters.subAccount])

  const setFilters = useCallback((next: GlobalFilters | ((current: GlobalFilters) => GlobalFilters)) => { setFiltersState((current) => (typeof next === 'function' ? next(current) : next)); setReportedRange(null) }, [])
  const resetFilters = useCallback(() => setFilters(defaultFilters), [setFilters])
  const query = useMemo(() => filtersToQuery(filters), [filters])
  const anchorMonth = filters.month ?? latestMonth
  const resolvedRange = useMemo(() => reportedRange ?? (anchorMonth ? resolveRange(filters.period, anchorMonth) : null), [reportedRange, anchorMonth, filters.period])
  const reportRange = useCallback((range: RangeBlock | undefined) => { if (range) setReportedRange((current) => (current && current.from === range.from && current.to === range.to && current.scope?.mode === range.scope?.mode && current.scope?.label === range.scope?.label && current.scope?.sites === range.scope?.sites ? current : range)) }, [])
  const reportSource = useCallback((source: SourceBlock | undefined) => { if (source) setLastSource((current) => (current && current.as_of === source.as_of && current.synced_at === source.synced_at && current.stale === source.stale && current.primary_source === source.primary_source && current.ar_as_of === source.ar_as_of ? current : source)) }, [])

  const toast = useCallback((kind: ToastKind, title: string, detail?: string) => {
    const id = ++toastId.current
    setToasts((current) => [...current, { id, kind, title, detail }])
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), kind === 'error' ? 9000 : 5000)
  }, [])
  const dismissToast = useCallback((id: number) => setToasts((current) => current.filter((t) => t.id !== id)), [])

  // Switching modes must never leak cached demo payloads into live cards (keys are mode-prefixed, but clear anyway).
  useEffect(() => { queryClient.invalidate() }, [mode])

  const value = useMemo<DashboardContextValue>(() => ({
    ready: decision !== null && signedIn,
    mode,
    decision: decision ?? { mode: 'demo', reason: 'unreachable', banner: null, status: null, error: null },
    api,
    systemStatus,
    refreshStatus, redetectMode,
    filters, setFilters, resetFilters, query,
    dimensions, dimensionsError: dimensionsQuery.error, latestMonth, anchorMonth, resolvedRange, reportRange, lastSource, reportSource,
    verticalLabels, setVerticalLabels: setVerticalLabelsState,
    page, jobNumber, navigate, openJob,
    toasts, toast, dismissToast,
  }), [decision, mode, api, systemStatus, refreshStatus, redetectMode, filters, setFilters, resetFilters, query, dimensions, dimensionsQuery.error, latestMonth, anchorMonth, resolvedRange, reportRange, lastSource, reportSource, verticalLabels, page, jobNumber, navigate, openJob, toasts, toast, dismissToast])

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>
}

export function useDashboard(): DashboardContextValue {
  const value = useContext(DashboardContext)
  if (!value) throw new Error('useDashboard must be used inside DashboardProvider')
  return value
}

/** Cache key helper that namespaces by data mode so demo and live payloads never collide. */
export function useQueryKey() {
  const { mode } = useDashboard()
  return useCallback((route: string, params?: Record<string, unknown>) => queryKey(`${mode}/${route}`, params), [mode])
}
