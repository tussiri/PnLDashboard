import type { IsoMonth, Period, RangeBlock } from './apiTypes'

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const PERIODS: Period[] = ['MTD', 'QTD', 'YTD', 'T12M']

export function parseMonth(iso: IsoMonth): { year: number; month: number } {
  const [y, m] = iso.split('-').map(Number)
  return { year: y, month: m }
}

export function toIsoMonth(year: number, month: number): IsoMonth {
  // month is 1-based; normalise overflow / underflow
  const date = new Date(Date.UTC(year, month - 1, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`
}

export function addMonths(iso: IsoMonth, delta: number): IsoMonth {
  const { year, month } = parseMonth(iso)
  return toIsoMonth(year, month + delta)
}

export function monthsBetween(from: IsoMonth, to: IsoMonth): number {
  const a = parseMonth(from), b = parseMonth(to)
  return (b.year - a.year) * 12 + (b.month - a.month) + 1
}

export function monthLabel(iso: IsoMonth, style: 'short' | 'long' | 'tick' = 'short'): string {
  const { year, month } = parseMonth(iso)
  const name = MONTHS_SHORT[month - 1] ?? iso
  if (style === 'tick') return `${name} ${String(year).slice(2)}`
  if (style === 'long') return `${['January','February','March','April','May','June','July','August','September','October','November','December'][month - 1]} ${year}`
  return `${name} ${year}`
}

/** Mirrors the server's period resolution rules from docs/api-contract.md. */
export function resolveRange(period: Period, anchor: IsoMonth): RangeBlock {
  const { year, month } = parseMonth(anchor)
  if (period === 'MTD') return { from: anchor, to: anchor, months: 1 }
  if (period === 'QTD') {
    const quarterStart = Math.floor((month - 1) / 3) * 3 + 1
    return { from: toIsoMonth(year, quarterStart), to: anchor, months: month - quarterStart + 1 }
  }
  if (period === 'YTD') return { from: toIsoMonth(year, 1), to: anchor, months: month }
  return { from: addMonths(anchor, -11), to: anchor, months: 12 }
}

/** The equivalent prior range used for deltas (prior month / prior QTD / prior YTD / prior 12). */
export function priorRange(period: Period, range: RangeBlock): RangeBlock {
  if (period === 'MTD') { const m = addMonths(range.to, -1); return { from: m, to: m, months: 1 } }
  if (period === 'QTD') { const to = addMonths(range.to, -3); return { from: addMonths(range.from, -3), to, months: range.months } }
  if (period === 'YTD') { const to = addMonths(range.to, -12); return { from: addMonths(range.from, -12), to, months: range.months } }
  return { from: addMonths(range.from, -12), to: addMonths(range.to, -12), months: 12 }
}

/** "Jan–Aug 2026 · 8 months" / "Aug 2026 · 1 month" / "Sep 2025–Aug 2026 · 12 months" */
export function rangeLabel(range: RangeBlock | null | undefined): string {
  if (!range) return ''
  const a = parseMonth(range.from), b = parseMonth(range.to)
  const unit = range.months === 1 ? 'month' : 'months'
  if (range.months === 1) return `${monthLabel(range.to)} · 1 month`
  if (a.year === b.year) return `${MONTHS_SHORT[a.month - 1]}–${MONTHS_SHORT[b.month - 1]} ${b.year} · ${range.months} ${unit}`
  return `${MONTHS_SHORT[a.month - 1]} ${a.year}–${MONTHS_SHORT[b.month - 1]} ${b.year} · ${range.months} ${unit}`
}

export function monthInRange(month: IsoMonth, range: RangeBlock): boolean {
  return month >= range.from && month <= range.to
}

export function listMonths(from: IsoMonth, to: IsoMonth): IsoMonth[] {
  const out: IsoMonth[] = []
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m)
  return out
}

export function daysInMonth(iso: IsoMonth): number {
  const { year, month } = parseMonth(iso)
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}
