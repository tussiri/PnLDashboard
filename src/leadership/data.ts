import { useMemo } from 'react'
import { useApiQuery } from '../hooks/useApiQuery'
import type { LeadershipAccount, LeadershipConfig, LeadershipRow, LeadershipRowsResponse } from '../services/apiTypes'
import { queryKey } from '../services/queryClient'
import { accountSummary, type AccountSummary, type MetricOptions } from './metrics'
import { addDays } from './routes'
import { useLeadership } from './state'

/** Rows for `weeks` weeks ending at the selected week, for an account slug or a scope. */
export function useRows(account: string | undefined, weeks = 1) {
  const { api, keyPrefix, weekStart, decision } = useLeadership()
  const key = decision && account && weekStart ? queryKey(`${keyPrefix}/leadership/rows`, { account, week: weekStart, weeks }) : null
  return useApiQuery<LeadershipRowsResponse>(key, (signal) => api.leadershipRows({ account, week: weekStart, weeks }, signal), [api, account, weekStart, weeks])
}

export const segmentOrder = (account: LeadershipAccount | undefined) => (account?.segments ?? []).slice().sort((a, b) => a.sort - b.sort).map((s) => s.name)

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
    failedSyncs: (config?.status.syncs ?? []).filter((s) => s.status === 'failed' && (s.integration_name.startsWith('winteam') || s.integration_name === 'nightly' || s.integration_name === 'relay')).map((s) => ({ integration: s.integration_name, at: s.completed_at ?? s.started_at })),
    weekInProgress: Boolean(week?.in_progress),
  }
}
