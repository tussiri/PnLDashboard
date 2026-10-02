import { useMemo } from 'react'
import { useApiQuery } from '../hooks/useApiQuery'
import type { LeadershipAccount, LeadershipConfig, LeadershipMonth, LeadershipMonthlyJob, LeadershipMonthlyResponse, LeadershipMonthResponse, LeadershipRow, LeadershipRowsResponse } from '../services/apiTypes'
import { queryKey } from '../services/queryClient'
import { accountSummary, type AccountSummary, type MetricOptions } from './metrics'
import { addDays } from './routes'
import { useLeadership } from './state'

/**
 * Rows for `weeks` weeks ending at the selected week, for an account slug or a scope, shaped per
 * account (prepareRows): pallet jobs inside their site, report groups, subcontracted sites split out.
 */
export function useRows(account: string | undefined, weeks = 1) {
  const { api, keyPrefix, weekStart, decision, accountBySlug } = useLeadership()
  const key = decision && account && weekStart ? queryKey(`${keyPrefix}/leadership/rows`, { account, week: weekStart, weeks }) : null
  const q = useApiQuery<LeadershipRowsResponse>(key, (signal) => api.leadershipRows({ account, week: weekStart, weeks }, signal), [api, account, weekStart, weeks])
  const data = useMemo(() => (q.data ? { ...q.data, rows: prepareRows(q.data.rows, accountBySlug) } : q.data), [q.data, accountBySlug])
  return { ...q, data }
}

/**
 * The month-end rollup of one account (or scope): every site, subcontracted ones included (at month end
 * they are invoiced and their subcontractors have billed), shaped like the weekly rows.
 */
export function useMonthRows(account: string | undefined, month: string | undefined) {
  const { api, keyPrefix, decision, accountBySlug } = useLeadership()
  const key = decision && account && month ? queryKey(`${keyPrefix}/leadership/month`, { account, month }) : null
  const q = useApiQuery<LeadershipMonthResponse>(key, (signal) => api.leadershipMonth(account!, month!, signal), [api, account, month])
  const data = useMemo(() => (q.data ? { ...q.data, rows: prepareRows(q.data.rows, accountBySlug, { keepSubcontracted: true }) } : q.data), [q.data, accountBySlug])
  return { ...q, data }
}

/** The month before YYYY-MM. */
export const priorMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

/** Days in a month (YYYY-MM), for per-day figures in the month rollup. */
export const daysInMonth = (month: string) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate() }

/** Subcontracted: marked so, or no delivery model recorded and only vendor cost (no hours) this week. */
export const isSubcontracted = (r: LeadershipRow) => r.delivery_model === 'subcontracted' || (r.delivery_model == null && !r.hours && (r.sub_week ?? 0) > 0)

export const PALLET_GROUPS = ['Pallet sites', 'Janitorial only'] as const

const ADDITIVE = ['labor', 'hours', 'ot_hours', 'ot_dollars', 'budget_hours', 'budget_dollars', 'revenue_month_amount', 'prior_revenue',
  'prior_labor', 'prior_sub', 'sub_week', 'revenue_allocated', 'alloc_management', 'alloc_burden', 'alloc_overhead'] as const

/**
 * The weekly reports' site shape, per account:
 * - a pallet job (role 'pallet') is added into its parent site for the same week, keeping its labor,
 *   hours and OT hours as the pallet share (an orphan pallet job stays a site of its own);
 * - group_by 'pallet' names each site's group Pallet sites or Janitorial only;
 * - split_subcontracted drops subcontracted sites (they have their own tab).
 */
export function prepareRows(rows: LeadershipRow[], accountBySlug: (slug: string | undefined) => LeadershipAccount | undefined,
  { keepSubcontracted = false }: { keepSubcontracted?: boolean } = {}): LeadershipRow[] {
  const key = (r: LeadershipRow, job: string) => `${r.week_start}|${r.company}|${job}`
  const byKey = new Map(rows.filter((r) => r.role !== 'pallet').map((r) => [key(r, r.job_number), { ...r, kids: [r.job_number], pallet_labor: 0, pallet_hours: 0, pallet_ot_hours: 0 } as LeadershipRow]))
  const out: LeadershipRow[] = [...byKey.values()]
  for (const r of rows.filter((x) => x.role === 'pallet')) {
    const parent = r.parent_job_number ? byKey.get(key(r, r.parent_job_number)) : undefined
    if (!parent) { out.push({ ...r, role: 'site', kids: [r.job_number] }); continue }
    for (const f of ADDITIVE) (parent as unknown as Record<string, number>)[f] = ((parent[f] as number) ?? 0) + ((r[f] as number) ?? 0)
    parent.dt_hours = (parent.dt_hours ?? 0) + (r.dt_hours ?? 0)
    parent.revenue_run_rate = (parent.revenue_run_rate ?? 0) + (r.revenue_run_rate ?? 0)
    if (r.variable_run_rate != null) parent.variable_run_rate = (parent.variable_run_rate ?? 0) + r.variable_run_rate
    parent.pallet_labor = (parent.pallet_labor ?? 0) + r.labor
    parent.pallet_hours = (parent.pallet_hours ?? 0) + r.hours
    parent.pallet_ot_hours = (parent.pallet_ot_hours ?? 0) + r.ot_hours
    parent.kids = [...(parent.kids ?? []), r.job_number]
  }
  return out.filter((r) => {
    const account = accountBySlug(r.account_slug ?? undefined)
    if (account?.split_subcontracted && !keepSubcontracted && isSubcontracted(r)) return false
    if (account?.group_by === 'pallet' && r.role === 'site') r.segment = (r.kids?.length ?? 1) > 1 ? PALLET_GROUPS[0] : PALLET_GROUPS[1]
    return true
  })
}

export const segmentOrder = (account: LeadershipAccount | undefined) => (account?.group_by === 'pallet' ? [...PALLET_GROUPS]
  : (account?.segments ?? []).slice().sort((a, b) => a.sort - b.sort).map((s) => s.name))

/** Rows of one week. */
export const rowsOfWeek = (rows: LeadershipRow[] | undefined, weekStart: string | undefined) => (rows ?? []).filter((r) => r.week_start === weekStart)

/** The account summary for one week of rows. */
export function useSummary(rows: LeadershipRow[] | undefined, account: LeadershipAccount | undefined, options: MetricOptions): AccountSummary | null {
  return useMemo(() => (rows ? accountSummary(rows, options, segmentOrder(account)) : null), [rows, account, options])
}

/**
 * The weekly reports' vocabulary. Labor % is total labor ÷ invoicing; total labor is direct labor plus,
 * for accounts measured with it (cost basis labor_plus_vendor), agency or subcontractor cost.
 */
export const measureLabel = (_account?: LeadershipAccount) => 'Labor %'
export const costLabel = (_account?: LeadershipAccount) => 'Total labor'
export const includesVendor = (account: LeadershipAccount | undefined) => account?.cost_basis === 'labor_plus_vendor'
/** What the account's groups are called: "BU" for Amazon, "Segment" by default. */
export const segmentLabel = (account: LeadershipAccount | undefined) => account?.segment_label || 'Segment'
/** What its non-payroll labor cost is called: "Agency sub", "Subcontractor", "Vendor". */
export const vendorLabel = (account: LeadershipAccount | undefined) => account?.vendor_label || 'Vendor'
/** A label inside a sentence: lower case, except an acronym such as BU. */
export const inSentence = (label: string) => (/^[A-Z]{2,}$/.test(label) ? label : label.toLowerCase())

/** Per-week measure series for a trend chart. */
export function weeklySeries(rows: LeadershipRow[], weeks: string[], account: LeadershipAccount | undefined, options: MetricOptions) {
  return weeks.map((w) => {
    const week = rows.filter((r) => r.week_start === w)
    if (!week.length) return { week: w, summary: null }
    return { week: w, summary: accountSummary(week, options, segmentOrder(account)) }
  })
}

export interface DataFlags {
  /** Labor for the week is estimated (no pay report). */
  estimated: boolean
  /** The revenue month is older than the month before the week's month. */
  revenueLag: { revenueMonth: string; expectedMonth: string } | null
  /** The last run of each WinTeam integration that failed. */
  failedSyncs: { integration: string; at: string | null }[]
  weekInProgress: boolean
  /** The month-end rollup: subcontractor invoices received of expected, and sites with no billing yet. */
  month?: { subsExpected: number; subsReceived: number; notInvoiced: number; inProgress: boolean }
}

/** Flags for a month rollup: estimated labor, sub invoices in, sites not yet invoiced, month in progress. */
export function monthFlags(config: LeadershipConfig | undefined, month: string, rows: LeadershipRow[]): DataFlags {
  const sites = rows.filter((r) => r.role === 'site')
  const expected = sites.filter((r) => r.sub_expected)
  const today = new Date().toISOString().slice(0, 10)
  return {
    estimated: rows.some((r) => r.labor_basis !== 'pay_report' && r.labor > 0),
    revenueLag: null,
    failedSyncs: dataFlags(config, undefined, []).failedSyncs,
    weekInProgress: false,
    month: {
      subsExpected: expected.length, subsReceived: expected.filter((r) => r.sub_received).length,
      notInvoiced: sites.filter((r) => r.revenue_month_basis !== 'job_cost' && r.revenue_month_basis !== 'relay_ar' && r.hours > 0).length,
      inProgress: `${month}-${String(daysInMonth(month)).padStart(2, '0')}` >= today,
    },
  }
}

/** Freshness and completeness facts about the selected week, for the notes panel. */
export function dataFlags(config: LeadershipConfig | undefined, weekStart: string | undefined, rows: LeadershipRow[]): DataFlags {
  const week = config?.weeks.find((w) => w.week_start === weekStart)
  const expectedMonth = weekStart ? `${addDays(weekStart, 6).slice(0, 7)}-01` : null
  const prev = expectedMonth ? new Date(`${expectedMonth}T00:00:00Z`) : null
  if (prev) prev.setUTCMonth(prev.getUTCMonth() - 1)
  const expected = prev ? prev.toISOString().slice(0, 10) : null
  const revenueMonth = rows.find((r) => r.revenue_month)?.revenue_month ?? week?.revenue_month ?? null
  return {
    estimated: rows.some((r) => r.labor_basis !== 'pay_report' && r.labor > 0),
    revenueLag: revenueMonth && expected && revenueMonth < expected ? { revenueMonth, expectedMonth: expected } : null,
    failedSyncs: (config?.status.syncs ?? []).filter((s) => s.status === 'failed' && (s.integration_name.startsWith('winteam') || ['nightly', 'relay', 'mail_inbox'].includes(s.integration_name))).map((s) => ({ integration: s.integration_name, at: s.completed_at ?? s.started_at })),
    weekInProgress: Boolean(week?.in_progress),
  }
}

/** Closed months of one account (job cost and Relay AR / AP per job, and its income statement). */
export function useMonthly(account: string | undefined, months = 3) {
  const { api, keyPrefix, decision } = useLeadership()
  const key = decision && account ? queryKey(`${keyPrefix}/leadership/monthly`, { account, months }) : null
  return useApiQuery<LeadershipMonthlyResponse>(key, (signal) => api.leadershipMonthly(account!, months, signal), [api, account, months])
}

/**
 * A month's billing for a job. A subcontracted job's contract revenue is booked to a GL line with no job
 * (from July 2026), so its job cost carries only the OS revenue line: Relay AR, else job cost revenue.
 * Other jobs: job cost revenue, else Relay AR (FedEx months before job cost closes).
 */
export const monthRevenue = (m: LeadershipMonth | undefined, subcontracted = false) =>
  (!m ? 0 : subcontracted ? (m.relay_ar > 0 ? m.relay_ar : m.revenue) : m.revenue > 0 ? m.revenue : m.relay_ar)
const isSub = (j: LeadershipMonthlyJob) => j.delivery_model === 'subcontracted'

/** The jobs of a site (itself and any rolled-in pallet job) in the monthly response. */
export function siteMonths(jobs: LeadershipMonthlyJob[], company: string | null, kids: string[] | undefined, job: string) {
  const wanted = new Set(kids ?? [job])
  return jobs.filter((j) => j.company === company && wanted.has(j.job_number))
}

/** A site's labor % for a closed month: (direct labor + sub x factor) ÷ billing, over its jobs. */
export function monthLaborPct(jobs: LeadershipMonthlyJob[], month: string, vendorFactor: number): number | null {
  let revenue = 0, labor = 0
  for (const j of jobs) {
    const m = j.months[month]
    revenue += monthRevenue(m, isSub(j))
    labor += (m?.direct_labor ?? 0) + (m?.subcontractors ?? 0) * vendorFactor
  }
  return revenue > 0 ? labor / revenue : null
}

/**
 * Months whose job cost is closed: on the self-performed jobs, job cost revenue covers at least half
 * of the month's billing, and job cost direct labor reaches 70% of the month's timekeeping labor. A
 * month whose revenue is in but whose labor is still posting (or carried by Relay billing) is left out,
 * so "actual" labor % is never read off a half-loaded month. Subcontracted jobs are ignored: from July
 * 2026 their revenue is booked to a GL line with no job.
 */
export function closedMonths(data: LeadershipMonthlyResponse | undefined): string[] {
  if (!data) return []
  return data.months.filter((m) => {
    let jobCost = 0, billing = 0, labor = 0, timekeeping = 0
    for (const j of data.jobs) {
      const x = j.months[m]
      if (!x || j.delivery_model === 'subcontracted') continue
      jobCost += x.revenue; billing += monthRevenue(x); labor += x.direct_labor; timekeeping += x.timekeeping_labor ?? 0
    }
    return billing > 0 && jobCost >= 0.5 * billing && (timekeeping === 0 || labor >= 0.7 * timekeeping)
  })
}
