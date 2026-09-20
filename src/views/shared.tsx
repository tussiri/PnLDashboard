import { ArrowUpRight, Info } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { useAuth } from '../auth/useAuth'
import { useDashboard, useQueryKey } from '../context/DashboardContext'
import { useApiQuery, type QueryState } from '../hooks/useApiQuery'
import type { JobRow, JobStatus, JobsResponse, RangeBlock, ReportingQuery, ScopeBlock, SourceBlock } from '../services/apiTypes'
import type { DashboardApi } from '../services/dataSource'
import { rangeLabel } from '../services/period'
import { isMeaningfulMargin, marginPercent, notMeaningfulReason } from '../utils'
import type { PageKey } from '../types'

type Ranged = { range?: RangeBlock; source?: SourceBlock }

/**
 * Fetch a reporting endpoint with the current mode/filters. The cache key is
 * namespaced by mode so demo payloads can never render inside a live card, and
 * the response range is reported back to the FilterBar.
 */
export function useReportQuery<T>(route: string, fetcher: (api: DashboardApi, signal: AbortSignal) => Promise<T>, params?: Record<string, unknown>, enabled = true): QueryState<T> {
  const { api, ready, reportRange, reportSource } = useDashboard()
  const { user } = useAuth()
  const key = useQueryKey()
  // Gated on the session: a signed-out page issues no reporting requests (only /auth/mode and /auth/me).
  const state = useApiQuery<T>(ready && enabled && user ? key(route, params) : null, (signal) => fetcher(api, signal), [api])
  const range = (state.data as Ranged | undefined)?.range
  const source = (state.data as Ranged | undefined)?.source
  useEffect(() => { if (range) reportRange(range) }, [range, reportRange])
  useEffect(() => { if (source) reportSource(source) }, [source, reportSource])
  return state
}

/** The global reporting query, plus a stable params object for cache keys. */
export function useReportingParams(): { query: ReportingQuery; params: Record<string, unknown> } {
  const { query } = useDashboard()
  return { query, params: query as Record<string, unknown> }
}

/** Shared /jobs query used by Overview, Profitability, Sites, Geography, Alerts. */
export function useJobsQuery(extra?: Partial<ReportingQuery>) {
  const { query } = useReportingParams()
  const merged = { ...query, ...extra }
  return useReportQuery<JobsResponse>('jobs', (api, signal) => api.jobs(merged, signal), merged)
}

export function rangeSubtitle(range: RangeBlock | undefined | null, units = 'USD'): string {
  return range ? `${rangeLabel(range)} · ${units}` : units
}

/** "Key accounts · 5 accounts · 526 sites" from `range.scope` (contract 2026-09-09). */
export function scopeLabel(scope: ScopeBlock | undefined | null): string | null {
  if (!scope) return null
  const plural = (count: number, noun: string) => `${count} ${count === 1 ? noun : `${noun}s`}`
  return [scope.label, plural(scope.accounts.length, 'account'), plural(scope.sites, 'site')].join(' · ')
}

/**
 * One line stating what the view covers. Reads `range.scope` from the payload the view reported
 * to the shell, so it is silent on API builds that do not send a scope block yet.
 */
export function ScopeLine({ range }: { range?: RangeBlock | null }) {
  const { resolvedRange } = useDashboard()
  const label = scopeLabel((range ?? resolvedRange)?.scope)
  if (!label) return null
  return <p className="scope-line num">{label}</p>
}

/**
 * Coverage disclosure: how much of all-account revenue the current scope holds. Shown only when
 * the API reports the share and it leaves something out (< 99%).
 */
export function ScopeCoverageLine({ range, share }: { range?: RangeBlock | null; share?: number | null }) {
  const { resolvedRange } = useDashboard()
  const scope = (range ?? resolvedRange)?.scope
  // Never name a scope we were not told: an unresolved scope block means no line at all, rather
  // than a default that could label one account's share as the key accounts'.
  if (share === null || share === undefined || share >= 0.99 || !scope) return null
  const verb = scope.accounts.length === 1 ? 'is' : 'are'
  return <p className="scope-line">{`${scope.label} ${verb} ${(share * 100).toFixed(1)}% of all-account revenue for this range.`}</p>
}

export function StatusBadge({ status, reasons }: { status: JobStatus; reasons?: string[] }) {
  return <span className={`status-badge status-badge--${status.toLowerCase()}`} title={reasons?.join('\n')}>{status}</span>
}

/** One factual line shown only in demo mode. */
export function DemoNotice({ children }: { children: ReactNode }) {
  const { mode } = useDashboard()
  if (mode !== 'demo') return null
  return <div className="data-notice"><strong>Demo data</strong><span>{children}</span></div>
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="inline-note"><Info size={12} aria-hidden="true" /><span>{children}</span></p>
}

export function JobLink({ job, children }: { job: Pick<JobRow, 'job_number'> | { job_number: string }; children?: ReactNode }) {
  const { openJob } = useDashboard()
  return <button type="button" className="link-button" onClick={(event) => { event.stopPropagation(); openJob(job.job_number) }}>{children ?? job.job_number}<ArrowUpRight size={11} aria-hidden="true" /></button>
}

export const jobLabel = (row: Pick<JobRow, 'job_name' | 'job_number'>) => `${row.job_name} · ${row.job_number}`

/**
 * Views that are self-contained like the executive Labor P&L dashboard (own header, account and
 * week selectors) and must NOT render the global FilterBar. App.tsx should subtract these from
 * `portfolioFilterPages`; exported here so the shell can consume it without this file depending on App.
 */
export const EXECUTIVE_VIEW_KEYS: ReadonlySet<PageKey> = new Set<PageKey>(['overview'])


/**
 * A site's gross margin, or `n/m` where the denominator is broken.
 *
 * The figure is withheld rather than the row, so the site stays findable and sortable; the title
 * names why. See `isMeaningfulMargin` for the threshold and the reasoning behind it.
 */
export function MarginCell({ job }: { job: JobRow }) {
  const value = job.gross_margin_pct ?? (job.revenue ? (job.gross_profit / job.revenue) * 100 : null)
  if (isMeaningfulMargin(value)) return <>{marginPercent(value)}</>
  return <abbr className="not-meaningful" title={notMeaningfulReason(job.revenue, job.labor_cost)}>{marginPercent(value)}</abbr>
}
