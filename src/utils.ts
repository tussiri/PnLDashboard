export const money = (value: number | null | undefined, digits = 1) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(digits)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(digits)}K`
  return `${sign}$${abs.toFixed(0)}`
}

/** Full-precision currency for tables: $1,234,567 */
export const moneyFull = (value: number | null | undefined, digits = 0) =>
  value === null || value === undefined || Number.isNaN(value) ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)

/** Axis tick money: one decimal from $1M up so neighbouring ticks never collide ($1.5M / $2.0M). */
export const moneyTick = (value: number) => (Math.abs(value) >= 1_000_000 ? money(value, 1) : money(value, 0))

export const percent = (value: number | null | undefined, digits = 1) => (value === null || value === undefined || Number.isNaN(value) ? '—' : `${value.toFixed(digits)}%`)
export const number = (value: number | null | undefined, digits = 0) => (value === null || value === undefined || Number.isNaN(value) ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value))
export const hours = (value: number | null | undefined) => (value === null || value === undefined ? '—' : `${number(value)} h`)
export const signed = (value: number | null | undefined, format: (v: number) => string) => (value === null || value === undefined || Number.isNaN(value) ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${format(Math.abs(value))}`)
export const pts = (value: number | null | undefined, digits = 1) => signed(value, (v) => `${v.toFixed(digits)} pts`)
export const sum = <T,>(rows: T[], selector: (row: T) => number | null | undefined) => rows.reduce((total, row) => total + (selector(row) ?? 0), 0)
export const ratio = (numerator: number, denominator: number): number | null => (denominator ? (numerator / denominator) * 100 : null)
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ')

export const fmtDate = (iso: string | null | undefined, options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }) => {
  if (!iso) return '—'
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: iso.length === 10 ? 'UTC' : undefined }).format(date)
}
export const fmtDateTime = (iso: string | null | undefined) => (iso ? fmtDate(iso, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')

export const relativeTime = (iso: string | null | undefined, now = Date.now()) => {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hrs = Math.round(minutes / 60)
  if (hrs < 48) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : typeof error === 'string' ? error : 'Something went wrong')

export const periodMonths = { MTD: 1, QTD: 3, YTD: 8, T12M: 12 } as const

/** Seed-only helper retained for the browser scenario demo and its tests. */
export function applyPeriod<T extends import('./types').JobSite>(job: T, period: keyof typeof periodMonths): T {
  const multiplier = periodMonths[period]
  const scale = (value: number) => Math.round(value * multiplier)
  return {
    ...job,
    revenue: scale(job.revenue),
    budgetRevenue: scale(job.budgetRevenue),
    labor: scale(job.labor),
    laborBudget: scale(job.laborBudget),
    supplies: scale(job.supplies),
    payrollBurden: scale(job.payrollBurden),
    otherDirectCosts: scale(job.otherDirectCosts),
    scheduledHours: scale(job.scheduledHours),
    actualHours: scale(job.actualHours),
    overtimeHours: scale(job.overtimeHours),
  }
}
