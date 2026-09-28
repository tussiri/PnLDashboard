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
/** What an account is measured by: labor % (the reference) or cost % = (labor + vendor) / invoice. */
export type CostBasis = 'labor' | 'labor_plus_vendor'

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
  /** Vendor (subcontractor) cost for the week; counted only under cost basis labor_plus_vendor. */
  sub_week?: number
  /** How the week's vendor cost was derived; 'prior_month_prorated' / 'trailing_3mo_projection' are projections. */
  sub_week_basis?: string | null
  /** Revenue moved onto (+) or off (-) this row by a parent-job allocation. */
  revenue_allocated?: number
  allocation_weight?: string | null
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
  costBasis?: CostBasis
  /** Per-segment targets that override `target` (e.g. Crane West sites of Amazon). */
  segmentTargets?: Record<string, number>
}

/** Derived values added to a row. */
export interface Derived {
  invoice: number
  laborPct: number | null
  /** Vendor cost counted in the measure (0 under cost basis labor). */
  vendor: number
  /** Labor plus counted vendor cost. */
  cost: number
  costPct: number | null
  /** The account's measure: laborPct, or costPct under labor_plus_vendor. Drives status and $ over target. */
  measurePct: number | null
  /** labor ÷ (hours + ½ OT hours): the straight-time rate. */
  baseRate: number
  /** Cost above target × invoice. */
  overDollars: number
  /** $ over ÷ base rate (0 for a site with no labor hours, e.g. fully subcontracted). */
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
  /** The target this row is judged against. */
  target: number
  status: LaborStatus
}

/** A row with its derived metrics; keeps every field of the row type it was computed from. */
export type SiteMetrics<R extends WeekRow = WeekRow> = R & Derived

export interface Rollup {
  count: number
  invoice: number
  labor: number
  vendor: number
  cost: number
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
  costPct: number | null
  measurePct: number | null
  otPct: number
  priorRevenue: number
  priorCost: number
  priorLaborPct: number | null
}

const PROJECTED_VENDOR_BASES = new Set(['prior_month_prorated', 'trailing_3mo_projection', 'relay_contract'])

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

/** The target for a row: its segment's override, else the account target. */
export const targetFor = (row: Pick<WeekRow, 'segment'>, opts: MetricOptions) => (row.segment != null ? opts.segmentTargets?.[row.segment] : undefined) ?? opts.target

export function siteMetrics<R extends WeekRow>(row: R, opts: MetricOptions): SiteMetrics<R> {
  const target = targetFor(row, opts)
  const invoice = invoiceOf(row, opts)
  const vendor = opts.costBasis === 'labor_plus_vendor' ? row.sub_week ?? 0 : 0
  const cost = row.labor + vendor
  const laborPct = ratio(row.labor, invoice)
  const costPct = ratio(cost, invoice)
  const measurePct = opts.costBasis === 'labor_plus_vendor' ? costPct : laborPct
  const baseRate = baseRateOf(row.labor, row.hours, row.ot_hours)
  const overDollars = invoice > 0 ? Math.max(0, cost - invoice * target) : 0
  const overHours = baseRate > 0 ? overDollars / baseRate : 0
  const otPremiumHours = 0.5 * row.ot_hours
  const overFromOtPremium = Math.min(otPremiumHours, overHours)
  return {
    ...row,
    invoice,
    laborPct,
    vendor,
    cost,
    costPct,
    measurePct,
    baseRate,
    overDollars,
    overHours,
    otPremiumHours,
    overFromOtPremium,
    overFromExtraHours: overHours - overFromOtPremium,
    otPct: row.hours > 0 ? row.ot_hours / row.hours : 0,
    otPremiumDollars: row.ot_dollars / 3,
    priorLaborPct: ratio(row.prior_labor + row.prior_sub, row.prior_revenue),
    target,
    status: statusOf(measurePct, target, opts.watchBand),
  }
}

export function rollup(rows: SiteMetrics[], target: number, costBasis: CostBasis = 'labor'): Rollup {
  const s = rows.reduce(
    (a, r) => {
      a.invoice += r.invoice; a.labor += r.labor; a.vendor += r.vendor; a.cost += r.cost; a.hours += r.hours; a.otHours += r.ot_hours
      a.otDollars += r.ot_dollars; a.budgetHours += r.budget_hours; a.budgetDollars += r.budget_dollars
      a.overHours += r.overHours; a.overDollars += r.overDollars
      a.priorRevenue += r.prior_revenue; a.priorCost += r.prior_labor + r.prior_sub
      if (r.measurePct != null && r.measurePct > (r.target ?? target)) a.over += 1
      return a
    },
    { invoice: 0, labor: 0, vendor: 0, cost: 0, hours: 0, otHours: 0, otDollars: 0, budgetHours: 0, budgetDollars: 0, overHours: 0, overDollars: 0, over: 0, priorRevenue: 0, priorCost: 0 },
  )
  return {
    ...s,
    count: rows.length,
    laborPct: ratio(s.labor, s.invoice),
    costPct: ratio(s.cost, s.invoice),
    measurePct: ratio(costBasis === 'labor_plus_vendor' ? s.cost : s.labor, s.invoice),
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
  | { kind: 'vendor_projected'; jobs: number; amount: number }
  | { kind: 'revenue_allocated'; jobs: number; amount: number; weight: string | null }

export interface SegmentSummary { segment: string; target: number; rollup: Rollup; status: LaborStatus }

export interface AccountSummary<R extends WeekRow = WeekRow> {
  sites: SiteMetrics<R>[]
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
  overTarget: { rows: SiteMetrics<R>[]; billedCount: number; rollup: Rollup; fromOtPremium: number; fromExtraHours: number }
  overtime: { hours: number; dollars: number; premiumDollars: number; pctOfHours: number; pctOfLabor: number; rowsWithOt: number; rowsWithLabor: number; unbilledOtHours: number }
  notes: AccountNote[]
}

/**
 * Everything the account views show for one week. `segmentOrder` lists the account's segments in
 * display order; segments present in the rows but not listed follow alphabetically.
 */
export function accountSummary<R extends WeekRow>(rows: R[], opts: MetricOptions, segmentOrder: string[] = []): AccountSummary<R> {
  const target = opts.target
  const sites = rows.map((r) => siteMetrics(r, opts))
  const billedRows = sites.filter((r) => r.role === 'site')
  const catchRows = sites.filter((r) => r.role === 'catch_all')
  const nbRows = sites.filter((r) => r.role === 'non_billed')
  const accountRows = sites.filter((r) => r.role !== 'non_billed')

  const basis = opts.costBasis ?? 'labor'
  const all = rollup(sites, target, basis)
  const account = rollup(accountRows, target, basis)
  const billed = rollup(billedRows, target, basis)
  const catchAll = rollup(catchRows, target, basis)
  const nonBilled = rollup(nbRows, target, basis)
  const catchHours = catchAllOverHours(catchRows)

  const present = [...new Set(billedRows.map((r) => r.segment ?? ''))].filter(Boolean)
  const ordered = [...segmentOrder.filter((s) => present.includes(s)), ...present.filter((s) => !segmentOrder.includes(s)).sort()]
  const segments = ordered.map((segment) => {
    const segmentTarget = opts.segmentTargets?.[segment] ?? target
    const r = rollup(billedRows.filter((x) => x.segment === segment), segmentTarget, basis)
    return { segment, target: segmentTarget, rollup: r, status: statusOf(r.measurePct, segmentTarget, opts.watchBand) }
  })

  const invoiced = billedRows.filter((r) => r.invoice > 0)
  const overRows = invoiced.filter((r) => r.overHours > 0.5)
  const fromOtPremium = overRows.reduce((a, r) => a + r.overFromOtPremium, 0)
  const overRollup = rollup(overRows, target, basis)

  const notes: AccountNote[] = []
  for (const c of catchRows) notes.push({ kind: 'catch_all', job_number: c.job_number, labor: c.labor, hours: c.hours, otHours: c.ot_hours, accountLaborPct: account.measurePct, sitesLaborPct: billed.measurePct })
  for (const n of nbRows) notes.push({ kind: 'non_billed', job_number: n.job_number, labor: n.labor, hours: n.hours, otHours: n.ot_hours, allInLaborPct: all.measurePct })
  // A subcontracted site has vendor cost instead of labor; only a billed site with neither is noted.
  const noLabor = sites.filter((r) => r.invoice > 0 && r.labor === 0 && !(r.sub_week ?? 0))
  if (noLabor.length) notes.push({ kind: 'billed_no_labor', jobs: noLabor.map((r) => ({ job_number: r.job_number, site_name: r.site_name })) })
  const budgetRatio = all.hours > 0 ? all.budgetHours / all.hours : null
  if (budgetRatio != null && budgetRatio < (opts.budgetReliabilityRatio ?? DEFAULTS.budgetReliabilityRatio)) notes.push({ kind: 'budget_unreliable', ratio: budgetRatio })
  const estimated = sites.filter((r) => r.labor > 0 && r.labor_basis && r.labor_basis !== 'pay_report')
  if (estimated.length) notes.push({ kind: 'labor_estimated', jobs: estimated.length, labor: estimated.reduce((a, r) => a + r.labor, 0) })
  if (opts.costBasis === 'labor_plus_vendor') {
    const projected = sites.filter((r) => (r.sub_week ?? 0) > 0 && PROJECTED_VENDOR_BASES.has(r.sub_week_basis ?? ''))
    if (projected.length) notes.push({ kind: 'vendor_projected', jobs: projected.length, amount: projected.reduce((a, r) => a + (r.sub_week ?? 0), 0) })
  }
  const allocated = sites.filter((r) => (r.revenue_allocated ?? 0) > 0)
  if (allocated.length) notes.push({ kind: 'revenue_allocated', jobs: allocated.length, amount: allocated.reduce((a, r) => a + (r.revenue_allocated ?? 0), 0), weight: allocated[0].allocation_weight ?? null })

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
