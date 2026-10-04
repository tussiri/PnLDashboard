/**
 * Derived metrics for the leadership labor P&L. One pure function per definition, generalized from
 * the Plano ISD reference dashboard (week ending 2026-09-20) so every account computes the same way.
 * Account-specific facts (which job is the catch-all, which is non-billed, segments, target, revenue
 * method) arrive as data on the rows and options, never as constants here.
 */

/** pallet rows are rolled into their parent site before metrics (data.ts rollupPallets). */
export type SiteRole = 'site' | 'catch_all' | 'non_billed' | 'pallet'
export type RevenueMethod = 'monthly_div' | 'weekly_billing'
/** last_month: the revenue month ÷ divisor; run_rate_3m: the 3-month average ÷ divisor (the FedEx report). */
export type InvoiceBasis = 'last_month' | 'run_rate_3m'
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
  /** Double-time hours, already inside ot_hours; their premium is full time rather than half. */
  dt_hours?: number
  /** Average monthly revenue over the revenue month and the two before it. */
  revenue_run_rate?: number | null
  /** Average monthly variable (OS, pallet) revenue over the same months. */
  variable_run_rate?: number | null
  /** Corporate allocations for the week: management wages, payroll burden, overhead. */
  alloc_management?: number
  alloc_burden?: number
  alloc_overhead?: number
  /** Rolled-in pallet job(s): their labor, hours and OT hours (already inside labor / hours / ot_hours). */
  pallet_labor?: number
  pallet_hours?: number
  pallet_ot_hours?: number
  /** Job numbers combined into this row (the site first). */
  kids?: string[]
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
  /** Share of vendor (agency / subcontractor) cost counted in labor; both weekly reports use 0.70. */
  vendorFactor?: number
  invoiceBasis?: InvoiceBasis
  /** Read the fixed / variable (OS) revenue split: accounts grouped by pallet sites only. */
  palletSplit?: boolean
  /** The month-end rollup (rows are months, invoice is the month's billing) or a week; days per period for per-day figures. */
  period?: 'week' | 'month'
  periodDays?: number
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
  /** Corporate allocations for the week (management wages + payroll burden + overhead). */
  allocation: number
  /** Invoice − labor − the full vendor cost − allocations (vendor at 100%, not the labor % factor). */
  margin: number
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
  allocation: number
  management: number
  burden: number
  overhead: number
  margin: number
  marginPct: number | null
}

export const PROJECTED_VENDOR_BASES = new Set(['prior_month_prorated', 'trailing_3mo_projection', 'relay_contract'])

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
  const monthly = opts.invoiceBasis === 'run_rate_3m' && row.revenue_run_rate != null ? row.revenue_run_rate : row.revenue_month_amount
  return monthly / (opts.divisor ?? DEFAULTS.divisor)
}

export function baseRateOf(labor: number, hours: number, otHours: number): number {
  return hours > 0 ? labor / (hours + 0.5 * otHours) : 0
}

/** The target for a row: its segment's override, else the account target. */
export const targetFor = (row: Pick<WeekRow, 'segment'>, opts: MetricOptions) => (row.segment != null ? opts.segmentTargets?.[row.segment] : undefined) ?? opts.target

export function siteMetrics<R extends WeekRow>(row: R, opts: MetricOptions): SiteMetrics<R> {
  const target = targetFor(row, opts)
  const invoice = invoiceOf(row, opts)
  const vendor = opts.costBasis === 'labor_plus_vendor' ? (row.sub_week ?? 0) * (opts.vendorFactor ?? 1) : 0
  const cost = row.labor + vendor
  const laborPct = ratio(row.labor, invoice)
  const costPct = ratio(cost, invoice)
  const measurePct = opts.costBasis === 'labor_plus_vendor' ? costPct : laborPct
  // OT pays half time on top, double time full time; dt_hours sit inside ot_hours.
  const otPremiumHours = 0.5 * row.ot_hours + 0.5 * (row.dt_hours ?? 0)
  const baseRate = row.hours > 0 ? row.labor / (row.hours + otPremiumHours) : 0
  const overDollars = invoice > 0 ? Math.max(0, cost - invoice * target) : 0
  const overHours = baseRate > 0 ? overDollars / baseRate : 0
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
    allocation: allocationOf(row),
    margin: invoice - row.labor - (row.sub_week ?? 0) - allocationOf(row),
  }
}

export const allocationOf = (row: WeekRow) => (row.alloc_management ?? 0) + (row.alloc_burden ?? 0) + (row.alloc_overhead ?? 0)

export function rollup(rows: SiteMetrics[], target: number, costBasis: CostBasis = 'labor'): Rollup {
  const s = rows.reduce(
    (a, r) => {
      a.invoice += r.invoice; a.labor += r.labor; a.vendor += r.vendor; a.cost += r.cost; a.hours += r.hours; a.otHours += r.ot_hours
      a.otDollars += r.ot_dollars; a.budgetHours += r.budget_hours; a.budgetDollars += r.budget_dollars
      a.overHours += r.overHours; a.overDollars += r.overDollars
      a.priorRevenue += r.prior_revenue; a.priorCost += r.prior_labor + r.prior_sub
      a.allocation += r.allocation; a.margin += r.margin
      a.management += r.alloc_management ?? 0; a.burden += r.alloc_burden ?? 0; a.overhead += r.alloc_overhead ?? 0
      if (r.measurePct != null && r.measurePct > (r.target ?? target)) a.over += 1
      return a
    },
    { invoice: 0, labor: 0, vendor: 0, cost: 0, hours: 0, otHours: 0, otDollars: 0, budgetHours: 0, budgetDollars: 0, overHours: 0, overDollars: 0, over: 0, priorRevenue: 0, priorCost: 0,
      allocation: 0, management: 0, burden: 0, overhead: 0, margin: 0 },
  )
  return {
    ...s,
    count: rows.length,
    laborPct: ratio(s.labor, s.invoice),
    costPct: ratio(s.cost, s.invoice),
    measurePct: ratio(costBasis === 'labor_plus_vendor' ? s.cost : s.labor, s.invoice),
    otPct: s.hours > 0 ? s.otHours / s.hours : 0,
    priorLaborPct: ratio(s.priorCost, s.priorRevenue),
    marginPct: ratio(s.margin, s.invoice),
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

/**
 * The weekly report's hours-to-cut model for one billed site, in straight-time hours at its base rate:
 * worked hours + OT premium hours (paid for, no coverage) + agency/subcontractor coverage (cost ÷ base
 * rate) against the allowance at target (invoicing × target ÷ base rate). `gap` > 0 is hours to cut
 * and equals `overHours`. A site with no labor hours has no base rate and is not rated.
 */
export interface CutRow<R extends WeekRow = WeekRow> {
  site: SiteMetrics<R>
  worked: number
  otPremium: number
  subHours: number
  total: number
  allowance: number
  gap: number
  baseRate: number
  /** labor ÷ hours: what an hour actually cost, OT included. */
  avgRate: number
  /** avgRate − baseRate: the OT premium spread over every hour. */
  otDrag: number
  /** Over, and the OT premium alone is at least the gap. */
  fixedByOt: boolean
}

export function cutRow<R extends WeekRow>(site: SiteMetrics<R>): CutRow<R> | null {
  if (site.role !== 'site' || site.invoice <= 0 || site.baseRate <= 0) return null
  const worked = site.hours
  const otPremium = site.otPremiumHours
  const subHours = site.vendor / site.baseRate
  const allowance = (site.invoice * site.target) / site.baseRate
  const total = worked + otPremium + subHours
  const gap = total - allowance
  const avgRate = site.hours > 0 ? site.labor / site.hours : 0
  return { site, worked, otPremium, subHours, total, allowance, gap, baseRate: site.baseRate, avgRate, otDrag: avgRate - site.baseRate, fixedByOt: gap > 0 && otPremium >= gap }
}

export interface CutSummary { rated: number; over: number; cut: number; otPremiumOver: number; fixedByOt: number }

export function cutSummary(rows: CutRow[]): CutSummary {
  const over = rows.filter((r) => r.gap > 0)
  return { rated: rows.length, over: over.length, cut: over.reduce((a, r) => a + r.gap, 0), otPremiumOver: over.reduce((a, r) => a + r.otPremium, 0), fixedByOt: over.filter((r) => r.fixedByOt).length }
}

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
  /** Hours to cut, per billed site with labor hours; `unrated` billed sites have none (fully subcontracted). */
  cut: { rows: CutRow<R>[]; unrated: number }
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
  const cutRows = invoiced.map((r) => cutRow(r)).filter((r): r is CutRow<R> => r != null)

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
    cut: { rows: cutRows, unrated: invoiced.length - cutRows.length },
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
