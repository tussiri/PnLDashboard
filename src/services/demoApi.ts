/**
 * Demo adapter: the same `DashboardApi` shape as the live client, answered from the Plano reference
 * week (demoLeadership.ts). Used only when the API is unreachable or the marts are empty, and always
 * labeled demo. Actions that would change data are not available in demo mode.
 */
import { ApiError, type LiveApi } from './api'
import { demoLeadershipConfig, demoLeadershipRows, demoLeadershipSite, demoLeadershipVendors } from './demoLeadership'

export type DashboardApi = LiveApi

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

  return {
    systemStatus: (signal) => settle(() => ({ database: 'demo', winteam: { enabled: false, configured: false, base_url_host: null, resources: [], poll_seconds: null, sync: 'on_demand' as const }, marts: { latest_month: null, rebuilt_at: null, job_month_rows: 0 }, forecast: null }), signal),
    syncAll: () => notAvailable('WinTeam sync'),
    syncSarus: () => notAvailable('Sarus sync'),
    rebuildMarts: () => notAvailable('Mart rebuild'),
    syncRuns: (_limit, signal) => settle(() => ({ runs: [] }), signal),
    leadershipConfig: (signal) => settle(demoLeadershipConfig, signal),
    leadershipRows: (query, signal) => settle(() => demoLeadershipRows(query), signal),
    leadershipSite: (company, jobNumber, query, signal) => settle(() => demoLeadershipSite(company, jobNumber, query), signal),
    leadershipVendors: (account, _months, signal) => settle(() => demoLeadershipVendors(account), signal),
    leadershipUpdateAccount: () => notAvailable('Account update'),
    leadershipReplaceSegments: () => notAvailable('Segment update'),
    leadershipAccountJobs: () => notAvailable('Job mapping'),
    leadershipMapJob: () => notAvailable('Job mapping'),
    leadershipReloadSeed: () => notAvailable('Seed reload'),
    leadershipImports: (_limit, signal) => settle(() => ({ files: [] }), signal),
    leadershipUpload: () => notAvailable('File import'),
  }
}
