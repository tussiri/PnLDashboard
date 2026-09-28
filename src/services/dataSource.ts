/**
 * The single seam between the UI and its data. Views only ever see `DashboardApi`.
 *
 *   LiveApi  -> src/services/api.ts   (fetches /api/v1)
 *   DemoApi  -> src/services/demoApi.ts (synthesizes contract shapes from seed data)
 *
 * Mode is decided once at startup from GET /system/status.
 */
import { api as liveApi, ApiError } from './api'
import type { SystemStatus } from './apiTypes'
import { createDemoApi, type DashboardApi } from './demoApi'

export type { DashboardApi }
export type DataMode = 'live' | 'demo'
export type ModeReason = 'live' | 'marts_empty' | 'unreachable'

export interface ModeDecision {
  mode: DataMode
  reason: ModeReason
  /** Banner copy shown above the page in demo mode; null in live mode. */
  banner: string | null
  status: SystemStatus | null
  error: string | null
}

export const BANNERS = {
  marts_empty: 'Demo data: no WinTeam data synced',
  unreachable: 'Demo data: API unreachable',
} as const

/** Pure selection rule so it can be unit tested without network. */
export function decideMode(status: SystemStatus | null, error: unknown = null): ModeDecision {
  if (status && (status.marts?.job_month_rows ?? 0) > 0) return { mode: 'live', reason: 'live', banner: null, status, error: null }
  if (status) return { mode: 'demo', reason: 'marts_empty', banner: BANNERS.marts_empty, status, error: null }
  const message = error instanceof ApiError ? error.detail : error instanceof Error ? error.message : error ? String(error) : 'No API'
  return { mode: 'demo', reason: 'unreachable', banner: BANNERS.unreachable, status: null, error: message }
}

export async function detectMode(signal?: AbortSignal): Promise<ModeDecision> {
  try {
    const status = await liveApi.systemStatus(signal)
    return decideMode(status)
  } catch (error) {
    if (signal?.aborted) throw error
    return decideMode(null, error)
  }
}

export const LiveApi: DashboardApi = liveApi
export const DemoApi: DashboardApi = createDemoApi()

export function apiFor(mode: DataMode): DashboardApi {
  return mode === 'live' ? LiveApi : DemoApi
}
