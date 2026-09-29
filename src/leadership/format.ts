/** Number formats of the leadership P&L, matching the reference dashboard. Missing values render as an en dash. */

const DASH = '–'
const missing = (v: number | null | undefined): v is null | undefined => v == null || Number.isNaN(v)

/** Whole dollars, negatives in parentheses: "$1,235", "($1,235)". */
export const money = (v: number | null | undefined) =>
  missing(v) ? DASH : `${v < 0 ? '(' : ''}$${Math.abs(Math.round(v)).toLocaleString('en-US')}${v < 0 ? ')' : ''}`

/** Thousands: "$84.5K", or "$184K" from $100K up. */
export const moneyK = (v: number | null | undefined) => (missing(v) ? DASH : `$${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}K`)

/** Whole hours: "1,952". */
export const hours = (v: number | null | undefined) => (missing(v) ? DASH : Math.round(v).toLocaleString('en-US'))

/** Hours to one decimal: "140.4". */
export const hours1 = (v: number | null | undefined) =>
  missing(v) ? DASH : v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** A fraction as a percentage to one decimal: 0.6455 is "64.6%". */
export const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? DASH : `${(v * 100).toFixed(1)}%`)

/** Signed percentage points, as the weekly report writes them: +2.4pp. */
export const pts = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? DASH : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}pp`)

/** "$18.73" */
export const rate = (v: number | null | undefined) => (missing(v) ? DASH : `$${v.toFixed(2)}`)
