/**
 * The month-end company view's figures (MonthEnd.tsx), from GET /leadership/company-pl: periods (each
 * month, the year to date, the last two months), any set of months summed, and the bridge from the GL as
 * posted to the month's pro forma (the GL plus Finance's adjustments). Pure, so it is tested without React.
 */
import type { AddbackKind, CompanyPlAccount, CompanyPlCompany, CompanyPlCustomer, CompanyPlEbita, CompanyPlGroup, CompanyPlMonth, PlCategory } from '../services/apiTypes'
import { monthShort } from './routes'

const FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** "October" from a month. */
export const monthName = (iso: string) => FULL[Number(iso.slice(5, 7)) - 1] ?? ''
/** "October 2026" from a month. */
export const monthFull = (iso: string) => `${monthName(iso)} ${iso.slice(0, 4)}`

export const ratio = (a: number, b: number) => (b ? a / b : null)

export interface Period { key: string; label: string; short: string; idx: number[] }

const CATS: PlCategory[] = ['revenue', 'direct_labor', 'payroll_taxes_insurance', 'subcontractors', 'supplies', 'other_direct', 'operating_expense']
const ADDBACKS: AddbackKind[] = ['interest', 'amortization', 'income_tax', 'depreciation']

/** Each loaded month (latest first), then the latest year to date and the last two months, when they span more than one month. */
export function periodsOf(months: CompanyPlMonth[]): Period[] {
  const n = months.length
  const single = months.map((m, i) => ({ key: m.month.slice(0, 7), label: monthFull(m.month), short: monthShort(m.month), idx: [i] })).reverse()
  if (!n) return single
  const last = months[n - 1].month
  const year = last.slice(0, 4)
  const ytd = months.map((m, i) => (m.month.startsWith(year) ? i : -1)).filter((i) => i >= 0)
  const out = [...single]
  if (ytd.length > 1) out.push({ key: 'ytd', label: `${year} year to date`, short: `${monthShort(months[ytd[0]].month)}–${monthShort(last)}`, idx: ytd })
  if (n > 1) {
    const a = months[n - 2].month, b = last
    out.push({ key: 'last2', label: `${monthName(a)} and ${monthFull(b)}`, short: `${monthShort(a)} + ${monthShort(b)}`, idx: [n - 2, n - 1] })
  }
  return out
}

/** The period a key selects; the latest month when the key is absent or unknown. */
export function periodOf(periods: Period[], key: string | undefined): Period | undefined {
  return periods.find((p) => p.key === key) ?? periods[0]
}

/** Table columns of the monthly tables: every month, the year to date and the last two months. */
export function columnsOf(months: CompanyPlMonth[], periods: Period[]): Period[] {
  const single = [...periods.filter((p) => p.idx.length === 1)].reverse()
  return [...single, ...periods.filter((p) => p.idx.length > 1)]
}

const add = <T extends object>(a: T, b: Partial<T> | undefined): T => {
  if (!b) return a
  const out = { ...a } as Record<string, unknown>
  for (const [k, v] of Object.entries(b)) if (typeof v === 'number') out[k] = ((out[k] as number) ?? 0) + v
  return out as T
}

/** Months summed: every amount of the company, overhead, groups, accounts, customers, companies and EBITA; ratios recomputed. */
export function sumMonths(months: CompanyPlMonth[], idx: number[]): CompanyPlMonth {
  const picked = idx.map((i) => months[i]).filter(Boolean)
  const [first, ...rest] = picked
  if (!first) throw new Error('No months to sum')
  const clone: CompanyPlMonth = JSON.parse(JSON.stringify(first))
  for (const m of rest) {
    clone.company = add(clone.company, m.company)
    clone.overhead = add(clone.overhead, m.overhead)
    clone.groups = clone.groups.map((g) => add(g, m.groups.find((x) => x.key === g.key)))
    for (const [slug, a] of Object.entries(m.accounts)) clone.accounts[slug] = clone.accounts[slug] ? add(clone.accounts[slug], a) : { ...a }
    const customers = new Map((clone.customers ?? []).map((c) => [c.name, c]))
    for (const c of m.customers ?? []) {
      const prev = customers.get(c.name)
      customers.set(c.name, prev ? { ...add(prev, c), jobs: [...new Set([...prev.jobs, ...c.jobs])].sort() } : { ...c })
    }
    clone.customers = [...customers.values()]
    const companies: Record<string, CompanyPlCompany> = { ...(clone.companies ?? {}) }
    for (const [name, c] of Object.entries(m.companies ?? {})) companies[name] = companies[name] ? add(companies[name], c) : { ...c }
    clone.companies = companies
    if (m.ebita) {
      const e: CompanyPlEbita = clone.ebita ? { ...add(clone.ebita, m.ebita), groups: { ...clone.ebita.groups } } : JSON.parse(JSON.stringify(m.ebita))
      if (clone.ebita) for (const [k, g] of Object.entries(m.ebita.groups)) e.groups[k] = e.groups[k] ? add(e.groups[k], g) : { ...g }
      clone.ebita = e
    }
    clone.adjustments = [...clone.adjustments, ...m.adjustments]
  }
  const c = clone.company
  c.gross_margin = ratio(c.gross_profit, c.operating_revenue)
  c.net_margin = ratio(c.net_profit, c.revenue)
  c.overhead_pct = ratio(c.overhead, c.operating_revenue)
  clone.groups = clone.groups.map((g) => ({ ...g, margin: ratio(g.after_overhead, g.revenue), pool_share: g.pool_share == null ? null : ratio(g.pool_charge, clone.overhead.pool) }))
  clone.month = first.month
  return clone
}

/** A group's figures summed over months (null when the group is missing). */
export function groupOver(months: CompanyPlMonth[], idx: number[], key: string): CompanyPlGroup | null {
  const gs = idx.map((i) => months[i]?.groups.find((g) => g.key === key)).filter((g): g is CompanyPlGroup => !!g)
  if (!gs.length) return null
  const out = gs.slice(1).reduce((a, g) => add(a, g), { ...gs[0] })
  return { ...out, margin: ratio(out.after_overhead, out.revenue) }
}

export function accountOver(months: CompanyPlMonth[], idx: number[], slug: string): CompanyPlAccount | null {
  const as = idx.map((i) => months[i]?.accounts[slug]).filter((a): a is CompanyPlAccount => !!a)
  return as.length ? as.slice(1).reduce((a, x) => add(a, x), { ...as[0] }) : null
}

export function companyOver(months: CompanyPlMonth[], idx: number[], name: string): CompanyPlCompany | null {
  const cs = idx.map((i) => months[i]?.companies?.[name]).filter((c): c is CompanyPlCompany => !!c)
  return cs.length ? cs.slice(1).reduce((a, x) => add(a, x), { ...cs[0] }) : null
}

/** Every category zero: a placeholder line set. */
export const zeroLines = () => ({ ...Object.fromEntries(CATS.map((c) => [c, 0])), direct_costs: 0, gross_profit: 0, before_overhead: 0 }) as Record<PlCategory, number> & { direct_costs: number; gross_profit: number; before_overhead: number }

/** Profit status of a margin: no revenue, loss, thin (under 3%), profit. */
export function marginStatus(margin: number | null): 'none' | 'loss' | 'thin' | 'profit' {
  if (margin == null) return 'none'
  if (margin < 0) return 'loss'
  return margin < 0.03 ? 'thin' : 'profit'
}

export type ProfitView = 'after' | 'before'
export const customerValue = (c: CompanyPlCustomer, view: ProfitView) => (view === 'after' ? c.after_overhead : c.before_overhead)

/** Customers ranked for the period: those that made money (largest first) and those that lost it (largest loss first). */
export function rankCustomers(customers: CompanyPlCustomer[], view: ProfitView) {
  const v = (c: CompanyPlCustomer) => customerValue(c, view)
  return { top: customers.filter((c) => v(c) > 0).sort((a, b) => v(b) - v(a)), bottom: customers.filter((c) => v(c) < 0).sort((a, b) => v(a) - v(b)) }
}

/** The companies on the Cross Tab, largest revenue first. */
export function companyNames(months: CompanyPlMonth[]): string[] {
  const rev = new Map<string, number>()
  for (const m of months) for (const [name, c] of Object.entries(m.companies ?? {})) rev.set(name, (rev.get(name) ?? 0) + c.revenue)
  return [...rev.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
}

export interface BridgeLine { key: string; label: string; revenue: number; cost: number; net: number; kind?: string }
export interface Bridge {
  gl: BridgeLine
  lines: BridgeLine[]
  proForma: BridgeLine
  /** Net before overhead by group, and corporate overhead, as posted, adjusted and pro forma, with the prior month pro forma. */
  groups: { key: string; name: string; revenue: number; gl: number; adjustments: number; proForma: number; prior: number | null }[]
}

/** From the GL as posted to the month's pro forma: the month less its adjustments' effects, each adjustment, then the month. */
export function bridgeOf(month: CompanyPlMonth, prior: CompanyPlMonth | null): Bridge {
  const c = month.company
  const proForma = { key: 'pf', label: 'Pro forma', revenue: c.revenue, cost: c.revenue - c.net_profit, net: c.net_profit }
  const lines = month.adjustments.filter((a) => (a.net_effect ?? 0) !== 0 || (a.revenue_effect ?? 0) !== 0 || Object.keys(a.groups ?? {}).length > 0)
    .map((a, i) => ({ key: `${a.adjustment_id}-${i}`, label: a.description, revenue: a.revenue_effect ?? 0, cost: a.cost_effect ?? 0, net: a.net_effect ?? 0, kind: a.kind }))
  const revenue = proForma.revenue - lines.reduce((s, l) => s + l.revenue, 0)
  const net = proForma.net - lines.reduce((s, l) => s + l.net, 0)
  const gl = { key: 'gl', label: 'GL as posted', revenue, cost: revenue - net, net }
  const effect = (key: string) => month.adjustments.reduce((s, a) => s + (a.groups?.[key] ?? 0), 0)
  const groups = month.groups.map((g) => ({ key: g.key, name: g.name, revenue: g.revenue, gl: g.before_overhead - effect(g.key), adjustments: effect(g.key), proForma: g.before_overhead,
    prior: prior?.groups.find((x) => x.key === g.key)?.before_overhead ?? null }))
  groups.push({ key: 'overhead', name: 'Corporate overhead', revenue: month.overhead.revenue_on_overhead_jobs, gl: -month.overhead.cost - effect('overhead'), adjustments: effect('overhead'),
    proForma: -month.overhead.cost, prior: prior ? -prior.overhead.cost : null })
  return { gl, lines, proForma, groups }
}

export const ADDBACK_LABEL: Record<AddbackKind, string> = { interest: 'Interest', amortization: 'Amortization', income_tax: 'Income taxes', depreciation: 'Depreciation' }
export const addbackKinds = ADDBACKS
