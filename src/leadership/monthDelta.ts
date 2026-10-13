import type { AccountSummary, SiteMetrics, WeekRow } from './metrics'

/**
 * Month against month on the account view: the selected month of the rollup against a comparison
 * month (the prior month unless one is picked). Sites pair up by company and job number; a site in
 * only one of the two months keeps the other side empty.
 */

/** A value in both months and the change between them; `pct` is the change over the comparison value. */
export interface Delta { cur: number | null; cmp: number | null; diff: number | null; pct: number | null }

export function delta(cur: number | null | undefined, cmp: number | null | undefined): Delta {
  const c = cur ?? null, p = cmp ?? null
  const diff = c != null && p != null ? c - p : null
  return { cur: c, cmp: p, diff, pct: diff != null && p != null && p !== 0 ? diff / Math.abs(p) : null }
}

export interface SiteCompare {
  key: string
  company: string | null
  job: string
  site: string
  segment: string | null
  invoice: Delta
  cost: Delta
  /** The account's measure (labor %, or cost % under labor plus vendor); `diff` is in points. */
  measurePct: Delta
  hours: Delta
  otDollars: Delta
}

type Row = WeekRow & { company: string | null }
const keyOf = (r: Row) => `${r.company ?? ''}|${r.job_number}`

/** Billed sites and the catch-all of either month, side by side, largest current labor first. */
export function compareSites<R extends Row>(cur: SiteMetrics<R>[], cmp: SiteMetrics<R>[]): SiteCompare[] {
  const keep = (r: SiteMetrics<R>) => r.role !== 'non_billed'
  const before = new Map(cmp.filter(keep).map((r) => [keyOf(r), r]))
  const now = new Map(cur.filter(keep).map((r) => [keyOf(r), r]))
  const keys = [...new Set([...now.keys(), ...before.keys()])]
  return keys.map((key) => {
    const a = now.get(key), b = before.get(key)
    const r = (a ?? b)!
    return {
      key, company: r.company, job: r.job_number, site: r.site_name, segment: r.segment ?? null,
      invoice: delta(a?.invoice, b?.invoice),
      cost: delta(a?.cost, b?.cost),
      measurePct: delta(a?.measurePct, b?.measurePct),
      hours: delta(a?.hours, b?.hours),
      otDollars: delta(a?.ot_dollars, b?.ot_dollars),
    }
  }).sort((x, y) => (y.cost.cur ?? -1) - (x.cost.cur ?? -1))
}

export interface GroupCompare { name: string; invoice: Delta; cost: Delta; measurePct: Delta }

/** The account's groups (segments) in both months, in the current month's order. */
export function compareGroups(cur: AccountSummary, cmp: AccountSummary | null): GroupCompare[] {
  const names = [...new Set([...cur.segments.map((g) => g.segment), ...(cmp?.segments ?? []).map((g) => g.segment)])]
  return names.map((name) => {
    const a = cur.segments.find((g) => g.segment === name)?.rollup
    const b = cmp?.segments.find((g) => g.segment === name)?.rollup
    return { name, invoice: delta(a?.invoice, b?.invoice), cost: delta(a?.cost, b?.cost), measurePct: delta(a?.measurePct, b?.measurePct) }
  })
}

/** Signed dollars: "+$1,235", "−$1,235". */
export const moneyChange = (v: number | null) => (v == null ? '–' : `${v >= 0 ? '+' : '−'}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`)
/** Signed change as a percentage of the comparison value: "+4.2%". */
export const pctChange = (v: number | null) => (v == null || !Number.isFinite(v) ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`)
/** Signed hours: "+1,204". */
export const hoursChange = (v: number | null) => (v == null ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('en-US')}`)
