/**
 * Pure helpers behind the executive chart system (ExecChart / ChartCard): month-boundary ticks, fixed
 * domains with clamping, nice dollar axes, delivery-aware chart selection, anomaly notes, the weekly
 * table + CSV export and the expand-dialog state. No DOM, no Chart.js - unit tested in charts.test.ts.
 */
import type { ExecutiveLaborRow } from '../../services/apiTypes'
import { toCsv } from '../../services/csv'
import { signed } from './model'

export type ExecMetric = 'pct' | 'dollars'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthOf = (iso: string) => iso.slice(0, 7)
const monthName = (iso: string) => { const m = Number(iso.slice(5, 7)) - 1; return MONTHS[m] ?? iso }

/**
 * X-axis labels for a weekly series: the month name on the first week of each month ("May", "Jun", ...), an
 * empty string elsewhere (an empty label keeps the faint week gridline; a null label would drop it). The
 * first week is labelled too unless the next month starts within `minFirstGap` weeks (2; 3 on the narrow site
 * cards), so a window that opens mid-month never gets two labels crammed together (monthly series label every
 * period). January carries its year
 * ("Jan 2027") because the window can straddle a year end. `boundaries` lists the labelled indexes (the
 * darker gridlines).
 */
export function monthTicks(weeks: string[], minFirstGap = 2): { labels: string[]; boundaries: number[] } {
  const labels = weeks.map(() => '')
  const boundaries: number[] = []
  weeks.forEach((w, i) => {
    if (i === 0 || monthOf(w) !== monthOf(weeks[i - 1])) boundaries.push(i)
  })
  const weekly = weeks.length > 1 && Date.parse(weeks[1]) - Date.parse(weeks[0]) <= 8 * 86_400_000
  if (weekly && boundaries.length > 1 && boundaries[0] === 0 && boundaries[1] < minFirstGap) boundaries.shift()
  for (const i of boundaries) {
    const w = weeks[i]
    labels[i] = w.slice(5, 7) === '01' ? `${monthName(w)} ${w.slice(0, 4)}` : monthName(w)
  }
  return { labels, boundaries }
}

/** Fixed percent domain: 0-120 % with a clamp so one anomalous week cannot flatten the others. */
export const PCT_DOMAIN = { min: 0, max: 120, ticks: 5 } as const
/** A week whose cost % exceeds this is annotated as an anomaly. */
export const ANOMALY_PCT = 150

/**
 * Dollar-axis cap for a series with one runaway period (the July close): 3× the median absolute value, rounded
 * up to the nice axis, so the other periods keep their shape; null when nothing needs clamping. Applied
 * symmetrically (−cap) to series that go negative, such as margins.
 */
export function dollarClampMax(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null && v !== 0).map(Math.abs).sort((a, b) => a - b)
  if (nums.length < 3) return null
  const median = nums[Math.floor(nums.length / 2)]
  const cap = median * 3
  return nums[nums.length - 1] > cap ? niceDollarAxis(0, cap).max : null
}

/** Values above `max` are plotted at `max` and flagged so the chart can draw a clamped marker and the tooltip the real value. */
export function clampSeries(values: (number | null)[], max: number, min?: number): { plotted: (number | null)[]; clamped: boolean[]; below: boolean[]; raw: (number | null)[] } {
  const clamped = values.map((v) => v !== null && v > max)
  const below = values.map((v) => v !== null && min !== undefined && v < min)
  return { plotted: values.map((v, i) => (clamped[i] ? max : below[i] ? (min as number) : v)), clamped, below, raw: values }
}

/** Percent tick step for 4-5 ticks on a fixed domain (0-120 -> 30). */
export const pctStep = (max: number, ticks = PCT_DOMAIN.ticks) => max / (ticks - 1)

/**
 * A 0-based (or negative-floored) dollar axis with 4-6 "nice" ticks: the step is 1 / 2 / 2.5 / 5 × a power of
 * ten, the bounds are multiples of it. Margin bars can go negative, so `min` floors at the nearest step below.
 */
export function niceDollarAxis(minValue: number, maxValue: number): { min: number; max: number; step: number } {
  const hi = Math.max(0, maxValue), lo = Math.min(0, minValue)
  const span = hi - lo
  if (!(span > 0)) return { min: 0, max: 1000, step: 250 }
  const raw = span / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = mag * (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10)
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step || step, step }
}

/** Axis tick for dollars: "$0", "$750", "$40k", "$1.2M". */
export function dollarTick(v: number): string {
  const a = Math.abs(v), sign = v < 0 ? '−' : ''
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(a % 1_000_000 === 0 ? 0 : 1)}M`
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(a % 1_000 === 0 ? 0 : 1)}k`
  return `${sign}$${a.toFixed(0)}`
}

/** Currency for tables and tooltips: whole dollars from $10k, cents below; the sign is kept ("−$1,234.50"). */
export function fmtCurrency(v: number): string {
  const a = Math.abs(v)
  const text = a >= 10_000 ? Math.round(a).toLocaleString('en-US') : a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${v < -0.005 ? '−' : ''}$${text}`
}

export const fmtPct = (v: number | null, digits = 1) => (v === null || Number.isNaN(v) ? '—' : `${v.toFixed(digits)}%`)

/** Value formatter per metric (tooltips, latest-value text). */
export const fmtMetric = (metric: ExecMetric, v: number | null) => (v === null ? '—' : metric === 'pct' ? fmtPct(v) : fmtCurrency(v))

/** Week-over-week text: percentage points for a ratio, percent change for dollars; null without two values. */
export function wowText(metric: ExecMetric, cur: number | null, prev: number | null): string | null {
  if (cur === null || prev === null) return null
  if (metric === 'pct') return `${signed(cur - prev)} pp WoW`
  if (!prev) return null
  return `${signed(((cur - prev) / Math.abs(prev)) * 100)}% WoW`
}

/**
 * Which trend a set of rows (a BU or a site across the window) gets: `labor` (Labor % vs target, Cost % beside it)
 * when any row carries self-performed hours, `cost_margin` (Cost % + margin dollars) when everything is subcontracted.
 * No rows at all reads as `labor` so an empty card still has a sensible axis.
 */
export function trendKind(rows: Pick<ExecutiveLaborRow, 'hours' | 'delivery_model'>[]): 'labor' | 'cost_margin' {
  if (!rows.length) return 'labor'
  return rows.some((r) => r.hours > 0 || r.delivery_model !== 'subcontracted') ? 'labor' : 'cost_margin'
}

/** Anomaly note for a week whose cost exceeds the threshold; the July 2026 close carries the flagged subcontract costs. */
export function anomalyNote(week: string, costPct: number | null, threshold = ANOMALY_PCT): string | null {
  if (costPct === null || costPct <= threshold) return null
  return week.startsWith('2026-07') ? 'cost exceeds invoicing · July close carries flagged subcontract costs' : 'cost exceeds invoicing this week'
}

// ------------------------------------------------------------- weekly table + CSV

export type CellKind = 'text' | 'pct' | 'dollars' | 'number' | 'pp' | 'flag'
export interface TableColumn { key: string; header: string; kind: CellKind }
export type TableRow = Record<string, string | number | boolean | null | undefined>
export interface WeeklyTable { columns: TableColumn[]; rows: TableRow[] }

/** Display text of one cell. Percentages to one decimal, currency without cents above $10k, flags as "~est". */
export function formatCell(kind: CellKind, value: TableRow[string]): string {
  if (value === null || value === undefined || value === '') return kind === 'flag' ? '' : '—'
  switch (kind) {
    case 'pct': return typeof value === 'number' ? fmtPct(value) : String(value)
    case 'dollars': return typeof value === 'number' ? fmtCurrency(value) : String(value)
    case 'number': return typeof value === 'number' ? Math.round(value).toLocaleString('en-US') : String(value)
    case 'pp': return typeof value === 'number' ? `${signed(value)} pp` : String(value)
    case 'flag': return value === true ? '~est' : value === false ? '' : String(value)
    default: return String(value)
  }
}

export const isNumericKind = (kind: CellKind) => kind !== 'text' && kind !== 'flag'

/** CSV of the expanded table: raw numbers (no separators or symbols) so spreadsheets parse them; flags as true/false. */
export function weeklyCsv(table: WeeklyTable): string {
  return toCsv(table.rows, table.columns.map((c) => ({ key: c.key, header: c.header, value: (row: TableRow) => { const v = row[c.key]; return v === undefined ? null : typeof v === 'number' ? Math.round(v * 100) / 100 : v } })))
}

/** File name for a card's CSV: "crane-ifs-labor-pct-2026-09-07.csv". */
export const csvFileName = (title: string, suffix?: string) => `${title.toLowerCase().replace(/%/g, 'pct').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}${suffix ? `-${suffix}` : ''}.csv`

// ---------------------------------------------------------------- expand dialog

export type ExpandAction = 'open' | 'close' | 'toggle'
export const expandReducer = (open: boolean, action: ExpandAction): boolean => (action === 'open' ? true : action === 'close' ? false : !open)

/** What a key press inside the dialog does: Escape closes, Tab cycles inside the trap, anything else passes through. */
export const dialogKeyAction = (key: string): 'close' | 'trap' | null => (key === 'Escape' || key === 'Esc' ? 'close' : key === 'Tab' ? 'trap' : null)

/**
 * Focus trap: the element to focus after Tab / Shift+Tab. Focus leaving the last element wraps to the first
 * (and vice versa); focus outside the list (or an empty list) lands on the first element.
 */
export function trapFocus<T>(focusables: T[], active: T | null | undefined, shift: boolean): T | null {
  if (!focusables.length) return null
  const i = active === null || active === undefined ? -1 : focusables.indexOf(active)
  if (i === -1) return focusables[0]
  if (!shift && i === focusables.length - 1) return focusables[0]
  if (shift && i === 0) return focusables[focusables.length - 1]
  return null
}
