/**
 * Demo adapter: the same `DashboardApi` shape as the live client, answered from the Plano reference
 * week (demoLeadership.ts). Used only when the API is unreachable or the marts are empty, and always
 * labeled demo. Actions that would change data are not available in demo mode.
 */
import { ApiError, type LiveApi } from './api'
import { demoCompanyPl } from './demoCompanyPl'
import { demoLeadershipConfig, demoLeadershipMonthly, demoLeadershipRows, demoLeadershipSite, demoLeadershipVendors, demoStaffingJob, demoStaffingSites } from './demoLeadership'

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
    syncPhotoValidation: () => notAvailable('PhotoValidation sync'),
    rebuildMarts: () => notAvailable('Mart rebuild'),
    syncRuns: (_limit, signal) => settle(() => ({ runs: [] }), signal),
    mailStatus: (signal) => settle(() => ({ configured: false, mailbox: null, schedule: { enabled: false, every_minutes: 30, first_lookback_days: 14, rules: [] }, last_run: null, recent: [] }), signal),
    mailPoll: () => notAvailable('Mailbox check'),
    updateMailSetting: () => notAvailable('Mailbox rule'),
    leadershipConfig: (signal) => settle(demoLeadershipConfig, signal),
    leadershipRows: (query, signal) => settle(() => demoLeadershipRows(query), signal),
    leadershipSite: (company, jobNumber, query, signal) => settle(() => demoLeadershipSite(company, jobNumber, query), signal),
    staffingJob: (company, jobNumber, query, signal) => settle(() => demoStaffingJob(company, jobNumber, query), signal),
    staffingSites: (account, query, signal) => settle(() => demoStaffingSites(account, query), signal),
    leadershipVendors: (account, _months, signal) => settle(() => demoLeadershipVendors(account), signal),
    leadershipDirectory: (account, signal) => settle(() => ({ account, as_of: null, sites: [],
      totals: { sites: 0, active: 0, self_perform: 0, subcontracted: 0, unassigned: 0, working: 0, hours_28d: 0, employees_28d: 0 } }), signal),
    fedexInvoices: (query, signal) => settle(() => ({ ...query, as_of: null, rows: [],
      totals: { invoices: 0, revenue: 0, invoice_total: 0, vendor_cost: 0, margin: null, margin_pct: null, vendors: 0, sites: 0, without_payable: 0, crane_payables: 0 } }), signal),
    leadershipBudget: (account, signal) => settle(() => ({ account, months: [], weeks: [] }), signal),
    saveBudget: () => notAvailable('Budget'),
    deleteBudget: () => notAvailable('Budget'),
    laborHours: (query, signal) => settle(() => ({ date_from: query.date_from ?? '', date_to: query.date_to ?? '', states: [], through: null, totals: { employees: 0, sites: 0, punches: 0, hours: 0 }, sites: [], employees: [] }), signal),
    leadershipQa: (account, _week, signal) => settle(() => ({ account, weeks: [], sites: [] }), signal),
    leadershipWeekChange: (account, week, signal) => settle(() => {
      const zero = { cost: 0, labor: 0, vendor: 0, hours: 0, ot_hours: 0, ot_premium: 0, sites_with_labor: 0 }
      return { account, complete: true, week: week ?? '', prior_week: '', current: zero, prior: zero, change: 0, change_pct: null, effects: { hours: 0, pay_rate: 0, ot_premium: 0, started: 0, stopped: 0, vendor: 0 }, site_count: 0, sites: [],
        source_changes: { sites: 0, change: 0, transitions: {} }, groups: [], recent: [], average_prior: null, vs_average_pct: null, prior_vs_average_pct: null, holidays: { current: [], prior: [] }, summary: { status: 'off' as const } }
    }, signal),
    leadershipFeedbackOverview: (account, month, signal) => settle(() => ({ account, month: `${month ?? ''}-01`, current: null, prior: null, months: [], year: { ratings: 0, average: null, since: '' }, low_sites: [], summary: { status: 'off' as const } }), signal),
    leadershipFeedback: (account, _months, signal) => settle(() => ({ account, since: '', lines: [], ratings: 0, average: null, low: 0, sites: 0, unmatched: 0, by_site: [] }), signal),
    leadershipMonthly: (account, _months, signal) => settle(() => demoLeadershipMonthly(account), signal),
    leadershipMonth: (account, month, signal) => settle(() => ({ month, account, rows: [] }), signal),
    leadershipCompany: (_months, signal) => settle(() => ({ months: [], accounts: [] }), signal),
    allocationStatus: () => notAvailable('Allocations'),
    updateAllocationSettings: () => notAvailable('Allocations'),
    updateAllocationMonth: () => notAvailable('Allocations'),
    companyPl: (months = 12, signal) => settle(() => { const pl = demoCompanyPl(); return { ...pl, months: pl.months.slice(-months) } }, signal),
    companyPlSettings: () => notAvailable('Overhead rule'),
    updateCompanyPlSettings: () => notAvailable('Overhead rule'),
    plAdjustments: () => notAvailable('Adjustments'),
    createPlAdjustment: () => notAvailable('Adjustments'),
    updatePlAdjustment: () => notAvailable('Adjustments'),
    clearPlAdjustment: () => notAvailable('Adjustments'),
    deletePlAdjustment: () => notAvailable('Adjustments'),
    subAccrualSuggestions: () => notAvailable('Adjustments'),
    acceptSubAccruals: () => notAvailable('Adjustments'),
    jobContracts: () => notAvailable('Contracts'),
    saveJobContract: () => notAvailable('Contracts'),
    deleteJobContract: () => notAvailable('Contracts'),
    leadershipUpdateAccount: () => notAvailable('Account update'),
    leadershipReplaceSegments: () => notAvailable('Segment update'),
    leadershipAccountJobs: () => notAvailable('Job mapping'),
    leadershipMapJob: () => notAvailable('Job mapping'),
    siteRegions: () => notAvailable('Regions'),
    setSiteRegion: () => notAvailable('Regions'),
    leadershipReloadSeed: () => notAvailable('Seed reload'),
    leadershipImports: (_limit, signal) => settle(() => ({ files: [] }), signal),
    leadershipUpload: () => notAvailable('File import'),
    readBudgetWorkbook: () => notAvailable('Budget workbook'),
    schoolCalendars: (signal) => settle(() => ({ districts: [] }), signal),
    schoolCalendar: (account, signal) => settle(() => ({ account, from: '', to: '', source: null, days: [], weeks: [] }), signal),
    saveSchoolDays: () => notAvailable('School calendar'),
    revertSchoolDay: () => notAvailable('School calendar'),
    saveSchoolSource: () => notAvailable('School calendar'),
    refreshSchoolCalendar: () => notAvailable('School calendar'),
    uploadSchoolCalendar: () => notAvailable('School calendar'),
  }
}
