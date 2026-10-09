/**
 * The Company page's "At a glance" story: pure functions over /leadership/company months, the featured
 * accounts' week summaries and their labor budgets. Every window is anchored to the last month the job cost
 * covers (the API's last month with revenue), never to today. A figure that cannot be known yet is null and
 * renders as a dash. Definitions: glossary.ts and docs/METRICS.md.
 */
import type { BudgetMonth, CompanyMonth } from '../services/apiTypes'
import { statusOf, type LaborStatus } from './metrics'

/** Months in the story's window, ending with the last month the job cost covers. */
export const WINDOW = 12
/** Months in each half of the revenue trend: the latest closed months against the ones before them. */
export const TREND = 3

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null)
const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0)
const ym = (iso: string) => iso.slice(0, 7)

// --- Window -----------------------------------------------------------------------

export interface StoryWindow {
  /** Every month in the window, oldest first, closed or not. */
  months: CompanyMonth[]
  /** The window's job-cost-closed months: the only ones counted in its figures. */
  closed: CompanyMonth[]
  from: string | null
  through: string | null
}

/** The last WINDOW months of the response (it ends with the last month that has revenue). */
export function storyWindow(months: CompanyMonth[], size = WINDOW): StoryWindow {
  const inWindow = months.slice(-size)
  return { months: inWindow, closed: inWindow.filter((m) => m.closed), from: inWindow[0]?.month ?? null, through: inWindow.at(-1)?.month ?? null }
}

// --- 1. Revenue -------------------------------------------------------------------

export interface RevenueStory {
  revenue: number | null
  grossProfit: number | null
  margin: number | null
  laborPct: number | null
  closedMonths: number
  /** Revenue of the latest TREND closed months against the TREND closed months before them; null without both. */
  trend: { recent: number; prior: number; change: number | null; recentFrom: string; recentTo: string } | null
  openMonths: string[]
  flagged: { month: string; flags: CompanyMonth['flags'] }[]
}

export function revenueStory(w: StoryWindow, trendSize = TREND): RevenueStory {
  const revenue = sum(w.closed, (m) => m.revenue)
  const profit = sum(w.closed, (m) => m.gross_profit)
  const labor = sum(w.closed, (m) => m.direct_labor)
  const recent = w.closed.slice(-trendSize)
  const prior = w.closed.slice(-trendSize * 2, -trendSize)
  const trend = recent.length === trendSize && prior.length === trendSize
    ? { recent: sum(recent, (m) => m.revenue), prior: sum(prior, (m) => m.revenue), change: null as number | null, recentFrom: recent[0].month, recentTo: recent.at(-1)!.month }
    : null
  if (trend) trend.change = trend.prior > 0 ? trend.recent / trend.prior - 1 : null
  const known = w.closed.length > 0
  return {
    revenue: known ? revenue : null,
    grossProfit: known ? profit : null,
    margin: ratio(profit, revenue),
    laborPct: ratio(labor, revenue),
    closedMonths: w.closed.length,
    trend,
    openMonths: w.months.filter((m) => !m.closed && m.revenue > 0).map((m) => m.month),
    flagged: w.closed.filter((m) => m.flags.length).map((m) => ({ month: m.month, flags: m.flags })),
  }
}

// --- 2. Every $100 billed ---------------------------------------------------------

/**
 * Whole parts of `total` in proportion to `values` (largest remainder): floors first, then one more to the
 * largest fractional remainders, ties to the earlier value, so the parts always sum to `total`.
 */
export function largestRemainder(values: number[], total = 100): number[] {
  const whole = sum(values, (v) => v)
  if (!(whole > 0) || values.some((v) => v < 0)) return values.map(() => 0)
  const exact = values.map((v) => (v / whole) * total)
  const parts = exact.map(Math.floor)
  const order = exact.map((e, i) => ({ i, r: e - Math.floor(e) })).sort((a, b) => b.r - a.r || a.i - b.i)
  const left = total - sum(parts, (p) => p)
  for (let k = 0; k < left; k += 1) parts[order[k % order.length].i] += 1
  return parts
}

export type Per100Key = 'labor' | 'subcontractors' | 'taxes' | 'other' | 'profit'
export interface Per100Part { key: Per100Key; label: string; amount: number; squares: number }
export interface Per100Story { revenue: number; parts: Per100Part[] }

/** Within this share of revenue, a negative "other job cost" is rounding and reads as zero. */
const OTHER_TOLERANCE = 0.005

/**
 * Where each $100 of closed-month revenue went. Other job cost is what job cost subtracts beyond direct
 * labor, subcontractors and payroll taxes. Null when it cannot be drawn as 100 squares: no revenue, a gross
 * loss, or costs that do not reconcile to gross profit.
 */
export function per100(closed: CompanyMonth[]): Per100Story | null {
  const revenue = sum(closed, (m) => m.revenue)
  if (!(revenue > 0)) return null
  const labor = sum(closed, (m) => m.direct_labor)
  const subcontractors = sum(closed, (m) => m.subcontractors)
  const taxes = sum(closed, (m) => m.payroll_taxes)
  const profit = sum(closed, (m) => m.gross_profit)
  let other = revenue - profit - labor - subcontractors - taxes
  if (other < 0 && -other <= OTHER_TOLERANCE * revenue) other = 0
  const amounts: [Per100Key, string, number][] = [
    ['labor', 'Direct labor', labor], ['subcontractors', 'Subcontractors', subcontractors], ['taxes', 'Payroll taxes and insurance', taxes],
    ['other', 'Other job cost', other], ['profit', 'Gross profit', profit],
  ]
  if (amounts.some(([, , v]) => v < 0)) return null
  const squares = largestRemainder(amounts.map(([, , v]) => v))
  return { revenue, parts: amounts.map(([key, label, amount], i) => ({ key, label, amount, squares: squares[i] })) }
}

// --- 3. Accounts ------------------------------------------------------------------

export interface AccountShare { slug: string; name: string; revenue: number; grossProfit: number; share: number; margin: number | null }
export interface AccountsStory { rows: AccountShare[]; revenue: number; top: AccountShare | null; belowZero: number }

/** Closed-month revenue and gross profit by featured account, the rest as Other last; accounts with no revenue are left out. */
export function accountsStory(closed: CompanyMonth[], names: Record<string, string>): AccountsStory {
  const totals = new Map<string, { revenue: number; profit: number }>()
  for (const m of closed) {
    for (const [slug, v] of Object.entries(m.by_account)) {
      const t = totals.get(slug) ?? { revenue: 0, profit: 0 }
      t.revenue += v.revenue
      t.profit += v.gross_profit
      totals.set(slug, t)
    }
  }
  const revenue = sum([...totals.values()], (t) => t.revenue)
  const rows = [...totals.entries()].filter(([, t]) => t.revenue > 0).map(([slug, t]) => ({
    slug, name: slug === 'other' ? 'Other accounts' : names[slug] ?? slug, revenue: t.revenue, grossProfit: t.profit,
    share: revenue > 0 ? t.revenue / revenue : 0, margin: ratio(t.profit, t.revenue),
  })).sort((a, b) => Number(a.slug === 'other') - Number(b.slug === 'other') || b.revenue - a.revenue)
  const named = rows.filter((r) => r.slug !== 'other')
  return { rows, revenue, top: named[0] ?? null, belowZero: named.filter((r) => r.grossProfit < 0).length }
}

// --- 4. This week -----------------------------------------------------------------

export interface WeekLine { slug: string; name: string; laborPct: number | null; target: number; watchBand?: number; overHours: number | null }
export interface WeekAccount extends WeekLine { status: LaborStatus }
export interface WeekStory { rows: WeekAccount[]; rated: number; over: number; watch: number; onTarget: number; noData: number; overHours: number | null }

/** The featured accounts in the selected (by default the last complete) week, worst labor % against target first. */
export function weekStory(lines: WeekLine[]): WeekStory {
  const rows = lines.map((l) => ({ ...l, status: statusOf(l.laborPct, l.target, l.watchBand) }))
  const rated = rows.filter((r) => r.status !== 'no_billing')
  rated.sort((a, b) => (b.laborPct! - b.target) - (a.laborPct! - a.target))
  const count = (s: LaborStatus) => rated.filter((r) => r.status === s).length
  return {
    rows: rated, rated: rated.length, over: count('over'), watch: count('watch'), onTarget: count('on_target'),
    noData: rows.length - rated.length, overHours: rated.length ? sum(rated, (r) => r.overHours ?? 0) : null,
  }
}

// --- 5. Against plan, else after allocations --------------------------------------

export interface PlanMonth { month: string; budget: number; actual: number; accounts: number }
export interface PlanStory { months: PlanMonth[]; accounts: number; budget: number; actual: number; variancePct: number | null; last: PlanMonth }

/**
 * Labor against the summed account labor budgets, per window month, counting in each month only the
 * accounts with both a budget and a finished month's actual, so the two lines compare like with like.
 * Null with fewer than two such months.
 */
export function planStory(budgets: { slug: string; months: BudgetMonth[] }[], windowMonths: string[]): PlanStory | null {
  const keys = new Set(windowMonths.map(ym))
  const byMonth = new Map<string, PlanMonth>()
  const used = new Set<string>()
  for (const b of budgets) {
    for (const m of b.months) {
      const key = ym(m.month)
      if (!keys.has(key) || m.in_progress || !m.actual || !(m.budget.total > 0)) continue
      const row = byMonth.get(key) ?? { month: m.month, budget: 0, actual: 0, accounts: 0 }
      row.budget += m.budget.total
      row.actual += m.actual.total
      row.accounts += 1
      byMonth.set(key, row)
      used.add(b.slug)
    }
  }
  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month))
  if (months.length < 2) return null
  const budget = sum(months, (m) => m.budget)
  const actual = sum(months, (m) => m.actual)
  return { months, accounts: used.size, budget, actual, variancePct: budget > 0 ? actual / budget - 1 : null, last: months.at(-1)! }
}

export interface AllocationsMonth { month: string; grossProfit: number; allocated: number; after: number; revenue: number }
export interface AllocationsStory { months: AllocationsMonth[]; after: number; allocated: number; share: number | null }

/** Gross profit less management wages, burden and overhead per closed month; null when nothing is allocated. */
export function allocationsStory(closed: CompanyMonth[]): AllocationsStory | null {
  const months = closed.map((m) => {
    const allocated = m.allocations.management_wages + m.allocations.burden + m.allocations.overhead
    return { month: m.month, grossProfit: m.gross_profit, allocated, after: m.gross_profit - allocated, revenue: m.revenue }
  })
  const allocated = sum(months, (m) => m.allocated)
  if (!(allocated > 0)) return null
  const after = sum(months, (m) => m.after)
  return { months, after, allocated, share: ratio(after, sum(months, (m) => m.revenue)) }
}
