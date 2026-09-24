/**
 * Derived metrics for the leadership labor P&L. One pure function per definition, generalized from
 * the Plano ISD reference dashboard (week ending 2026-09-20) so every account computes the same way.
 * Account-specific facts (which job is the catch-all, which is non-billed, segments, target, revenue
 * method) arrive as data on the rows and options, never as constants here.
 */

export type SiteRole = 'site' | 'catch_all' | 'non_billed'
export type RevenueMethod = 'monthly_div' | 'weekly_billing'
export type LaborStatus = 'on_target' | 'watch' | 'over' | 'no_billing'
export type LaborBasis = 'pay_report' | 'payroll_rate' | 'trailing_rate_estimate'

/** One job for one week, as the API delivers it. */
export interface WeekRow {
  job_number: string
  site_name: string
  /** Null for catch-all and non-billed jobs; the account's fallback segment otherwise. */
  segment: string | null
  role: SiteRole
  /** Monthly revenue the weekly invoice is derived from (method `monthly_div`). */
  revenue_month_amount: number
  /** Billed amount for the week itself (method `weekly_billing`). */
  invoice_week?: number | null
  labor: number
  /** Total hours, overtime included. */
  hours: number
  ot_hours: number
  /** Full overtime pay (1.5x), not the premium alone. */
  ot_dollars: number
  budget_hours: number
  budget_dollars: number
  prior_revenue: number
  prior_labor: number
  prior_sub: number
  labor_basis?: LaborBasis
}

export interface MetricOptions {
  /** Target labor % as a fraction (0.645). */
  target: number
  revenueMethod?: RevenueMethod
  /** Weeks per month for `monthly_div` (4.33). */
  divisor?: number
  /** Watch band above target, as a fraction (0.10 = 10 points). */
  watchBand?: number
  /** Budget hours below this share of actual hours are flagged as unreliable. */
  budgetReliabilityRatio?: number
}

export interface SiteMetrics extends WeekRow {
  invoice: number
  laborPct: number | null
  /** labor ÷ (hours + ½ OT hours): the straight-time rate. */
  baseRate: number
  overDollars: number
  overHours: number
  /** ½ × OT hours. */
  otPremiumHours: number
  /** The part of the hours over target explained by the OT premium (capped at hours over). */
  overFromOtPremium: number
  /** Hours over target beyond the OT premium. */
  overFromExtraHours: number
  otPct: number
  /** The half-time portion of OT pay: OT $ ÷ 3. */
  otPremiumDollars: number
  /** Prior closed month (labor + subcontractor) ÷ revenue. */
  priorLaborPct: number | null
  status: LaborStatus
}

export interface Rollup {
  count: number
  invoice: number
  labor: number
  hours: number
  otHours: number
  otDollars: number
  budgetHours: number
  budgetDollars: number
  overHours: number
  overDollars: number
  /** Rows above target. */
  over: number
  laborPct: number | null
  otPct: number
  priorRevenue: number
  priorCost: number
  priorLaborPct: number | null
}

const DEFAULTS = { revenueMethod: 'monthly_div' as RevenueMethod, divisor: 4.33, watchBand: 0.1, budgetReliabilityRatio: 0.8 }

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null)

export function statusOf(laborPct: number | null, target: number, watchBand = DEFAULTS.watchBand): LaborStatus {
  if (laborPct == null || !Number.isFinite(laborPct)) return 'no_billing'
  if (laborPct <= target) return 'on_target'
  if (laborPct <= target + watchBand) return 'watch'
  return 'over'
}

export function invoiceOf(row: WeekRow, opts: MetricOptions): number {
  const method = opts.revenueMethod ?? DEFAULTS.revenueMethod
  if (method === 'weekly_billing') return row.invoice_week ?? 0
  return row.revenue_month_amount / (opts.divisor ?? DEFAULTS.divisor)
}

export function baseRateOf(labor: number, hours: number, otHours: number): number {
  return hours > 0 ? labor / (hours + 0.5 * otHours) : 0
}

export function siteMetrics(row: WeekRow, opts: MetricOptions): SiteMetrics {
  const invoice = invoiceOf(row, opts)
  const laborPct = ratio(row.labor, invoice)
  const baseRate = baseRateOf(row.labor, row.hours, row.ot_hours)
  const overDollars = invoice > 0 ? Math.max(0, row.labor - invoice * opts.target) : 0
  const overHours = baseRate > 0 ? overDollars / baseRate : 0
  const otPremiumHours = 0.5 * row.ot_hours
  const overFromOtPremium = Math.min(otPremiumHours, overHours)
  return {
    ...row,
    invoice,
    laborPct,
    baseRate,
    overDollars,
    overHours,
    otPremiumHours,
    overFromOtPremium,
    overFromExtraHours: overHours - overFromOtPremium,
    otPct: row.hours > 0 ? row.ot_hours / row.hours : 0,
    otPremiumDollars: row.ot_dollars / 3,
    priorLaborPct: ratio(row.prior_labor + row.prior_sub, row.prior_revenue),
    status: statusOf(laborPct, opts.target, opts.watchBand),
  }
}

export function rollup(rows: SiteMetrics[], target: number): Rollup {
  const s = rows.reduce(
    (a, r) => {
      a.invoice += r.invoice; a.labor += r.labor; a.hours += r.hours; a.otHours += r.ot_hours
      a.otDollars += r.ot_dollars; a.budgetHours += r.budget_hours; a.budgetDollars += r.budget_dollars
      a.overHours += r.overHours; a.overDollars += r.overDollars
      a.priorRevenue += r.prior_revenue; a.priorCost += r.prior_labor + r.prior_sub
      if (r.laborPct != null && r.laborPct > target) a.over += 1
      return a
    },
    { invoice: 0, labor: 0, hours: 0, otHours: 0, otDollars: 0, budgetHours: 0, budgetDollars: 0, overHours: 0, overDollars: 0, over: 0, priorRevenue: 0, priorCost: 0 },
  )
  return {
    ...s,
    count: rows.length,
    laborPct: ratio(s.labor, s.invoice),
    otPct: s.hours > 0 ? s.otHours / s.hours : 0,
    priorLaborPct: ratio(s.priorCost, s.priorRevenue),
  }
}

/** A catch-all job has no billing, so all of its time counts as over target at its own base rate. */
export const catchAllOverHours = (rows: SiteMetrics[]) => rows.reduce((a, r) => a + r.hours + 0.5 * r.ot_hours, 0)

export type AccountNote =
  | { kind: 'catch_all'; job_number: string; labor: number; hours: number; otHours: number; accountLaborPct: number | null; sitesLaborPct: number | null }
  | { kind: 'non_billed'; job_number: string; labor: number; hours: number; otHours: number; allInLaborPct: number | null }
  | { kind: 'billed_no_labor'; jobs: { job_number: string; site_name: string }[] }
  | { kind: 'budget_unreliable'; ratio: number }
  | { kind: 'labor_estimated'; jobs: number; labor: number }

export interface SegmentSummary { segment: string; rollup: Rollup; status: LaborStatus }

export interface AccountSummary {
  sites: SiteMetrics[]
  /** Every row, non-billed included. */
  all: Rollup
  /** Sites plus catch-all: the account header. */
  account: Rollup
  /** Billed sites only. */
  billed: Rollup
  catchAll: Rollup
  nonBilled: Rollup
  catchAllOverHours: number
  /** Header hours over target: sites over target plus the catch-all in full. */
  headerOverHours: number
  segments: SegmentSummary[]
  overTarget: { rows: SiteMetrics[]; billedCount: number; rollup: Rollup; fromOtPremium: number; fromExtraHours: number }
  overtime: { hours: number; dollars: number; premiumDollars: number; pctOfHours: number; pctOfLabor: number; rowsWithOt: number; rowsWithLabor: number; unbilledOtHours: number }
  notes: AccountNote[]
}

/**
 * Everything the account views show for one week. `segmentOrder` lists the account's segments in
 * display order; segments present in the rows but not listed follow alphabetically.
 */
export function accountSummary(rows: WeekRow[], opts: MetricOptions, segmentOrder: string[] = []): AccountSummary {
  const target = opts.target
  const sites = rows.map((r) => siteMetrics(r, opts))
  const billedRows = sites.filter((r) => r.role === 'site')
  const catchRows = sites.filter((r) => r.role === 'catch_all')
  const nbRows = sites.filter((r) => r.role === 'non_billed')
  const accountRows = sites.filter((r) => r.role !== 'non_billed')

  const all = rollup(sites, target)
  const account = rollup(accountRows, target)
  const billed = rollup(billedRows, target)
  const catchAll = rollup(catchRows, target)
  const nonBilled = rollup(nbRows, target)
  const catchHours = catchAllOverHours(catchRows)

  const present = [...new Set(billedRows.map((r) => r.segment ?? ''))].filter(Boolean)
  const ordered = [...segmentOrder.filter((s) => present.includes(s)), ...present.filter((s) => !segmentOrder.includes(s)).sort()]
  const segments = ordered.map((segment) => {
    const r = rollup(billedRows.filter((x) => x.segment === segment), target)
    return { segment, rollup: r, status: statusOf(r.laborPct, target, opts.watchBand) }
  })

  const invoiced = billedRows.filter((r) => r.invoice > 0)
  const overRows = invoiced.filter((r) => r.overHours > 0.5)
  const fromOtPremium = overRows.reduce((a, r) => a + r.overFromOtPremium, 0)
  const overRollup = rollup(overRows, target)

  const notes: AccountNote[] = []
  for (const c of catchRows) notes.push({ kind: 'catch_all', job_number: c.job_number, labor: c.labor, hours: c.hours, otHours: c.ot_hours, accountLaborPct: account.laborPct, sitesLaborPct: billed.laborPct })
  for (const n of nbRows) notes.push({ kind: 'non_billed', job_number: n.job_number, labor: n.labor, hours: n.hours, otHours: n.ot_hours, allInLaborPct: all.laborPct })
  const noLabor = sites.filter((r) => r.invoice > 0 && r.labor === 0)
  if (noLabor.length) notes.push({ kind: 'billed_no_labor', jobs: noLabor.map((r) => ({ job_number: r.job_number, site_name: r.site_name })) })
  const budgetRatio = all.hours > 0 ? all.budgetHours / all.hours : null
  if (budgetRatio != null && budgetRatio < (opts.budgetReliabilityRatio ?? DEFAULTS.budgetReliabilityRatio)) notes.push({ kind: 'budget_unreliable', ratio: budgetRatio })
  const estimated = sites.filter((r) => r.labor_basis && r.labor_basis !== 'pay_report')
  if (estimated.length) notes.push({ kind: 'labor_estimated', jobs: estimated.length, labor: estimated.reduce((a, r) => a + r.labor, 0) })

  return {
    sites,
    all,
    account,
    billed,
    catchAll,
    nonBilled,
    catchAllOverHours: catchHours,
    headerOverHours: billed.overHours + catchHours,
    segments,
    overTarget: { rows: overRows, billedCount: invoiced.length, rollup: overRollup, fromOtPremium, fromExtraHours: overRollup.overHours - fromOtPremium },
    overtime: {
      hours: all.otHours,
      dollars: all.otDollars,
      premiumDollars: all.otDollars / 3,
      pctOfHours: all.otPct,
      pctOfLabor: all.labor > 0 ? all.otDollars / all.labor : 0,
      rowsWithOt: sites.filter((r) => r.ot_hours > 0).length,
      rowsWithLabor: sites.filter((r) => r.hours > 0).length,
      unbilledOtHours: catchAll.otHours + nonBilled.otHours,
    },
    notes,
  }
}
