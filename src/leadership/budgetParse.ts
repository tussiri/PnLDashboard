/**
 * Parse an account's monthly labor plan pasted from its budget workbook (Admin > Budgets). Excel copies a
 * range as tab-separated text, quoting cells that wrap ("School\ndays"); CSV works too. Columns are found by
 * their header, ignoring case, spaces and punctuation. Rows that are not a month (Year, Total) are skipped.
 */
export interface BudgetRow {
  month: string
  site_labor: number | null
  overhead_labor: number | null
  revenue: number | null
  supplies: number | null
  details: Partial<Record<'school_days' | 'staff_days' | 'closure_days' | 'summer_days' | 'stat_holidays', number>>
}
/** A week of the plan's day calendar: the week's site and overhead labor, and its stat-holiday pay. */
export interface BudgetWeekRow { week_end: string; site_labor: number; overhead_labor: number; holiday_labor: number; details: BudgetRow['details'] }
export interface ParsedBudget { kind: 'months' | 'weeks'; rows: BudgetRow[]; weeks: BudgetWeekRow[]; errors: string[]; skipped: string[] }

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9%]/g, '')
const COLUMNS: { key: keyof Omit<BudgetRow, 'month' | 'details'> | 'month' | 'total' | `d:${keyof BudgetRow['details']}`; test: (h: string) => boolean }[] = [
  { key: 'month', test: (h) => h === 'month' || h === 'period' },
  { key: 'site_labor', test: (h) => h.startsWith('sitelabor') },
  { key: 'overhead_labor', test: (h) => h.startsWith('overheadlabor') || h === 'overhead' },
  { key: 'total', test: (h) => h.startsWith('totallabor') },
  { key: 'revenue', test: (h) => h === 'revenue' || h === 'billing' || h.startsWith('revenue') },
  { key: 'supplies', test: (h) => h.startsWith('supplies') },
  { key: 'd:school_days', test: (h) => h.startsWith('schooldays') },
  { key: 'd:staff_days', test: (h) => h.startsWith('staffdays') },
  { key: 'd:closure_days', test: (h) => h.startsWith('closuredays') },
  { key: 'd:summer_days', test: (h) => h.startsWith('summerdays') },
  { key: 'd:stat_holidays', test: (h) => h.startsWith('statholiday') },
]
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Split delimited text into rows of cells, honoring quoted cells (which may hold the delimiter or line breaks). */
export function splitTable(text: string): string[][] {
  const delimiter = text.includes('\t') ? '\t' : ','
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"' && cell === '') quoted = true
    else if (c === delimiter) { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((x) => x.trim() !== ''))
}

/** "Jul 2026", "July 2026", "2026-07", "7/2026", "07/01/2026" -> "2026-07"; null when not a month. */
export function parseMonth(value: string): string | null {
  const v = value.trim().toLowerCase()
  let m = v.match(/^([a-z]{3})[a-z]*\.?\s+(\d{4})$/)
  if (m && MONTHS.includes(m[1])) return `${m[2]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}`
  m = v.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/)
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${m[2].padStart(2, '0')}`
  m = v.match(/^(\d{1,2})\/(?:\d{1,2}\/)?(\d{4})$/)
  if (m && +m[1] >= 1 && +m[1] <= 12) return `${m[2]}-${m[1].padStart(2, '0')}`
  return null
}

/** "$1,026,956", "(1,200)", "67.6%" -> number; "" -> null; NaN when unreadable. */
export function parseAmount(value: string): number | null {
  const v = value.trim()
  if (!v || v === '-' || v === '–') return null
  const negative = /^\(.*\)$/.test(v) || v.startsWith('-')
  const n = Number(v.replace(/[$,()%\s]/g, '').replace(/^-/, ''))
  return Number.isFinite(n) ? (negative ? -n : n) : NaN
}

/** "2026-09-13", "9/13/2026", "Sep 13, 2026", "Sep 13 2026" -> "2026-09-13"; null when not a date. */
export function parseDay(value: string): string | null {
  const v = value.trim().toLowerCase().replace(/,/g, '')
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  m = v.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})\s+(\d{4})$/)
  if (m && MONTHS.includes(m[1])) return `${m[3]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return null
}
const isSunday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay() === 0

/** The weekly calendar: Week ending, Site labor, Overhead labor, Stat holiday labor, day counts. */
function parseWeeks(table: string[][], headerAt: number): ParsedBudget {
  const errors: string[] = [], skipped: string[] = []
  const header = table[headerAt].map(compact)
  const find = (test: (h: string) => boolean) => header.findIndex(test)
  const at = {
    week: find((h) => h.startsWith('weekending') || h === 'week' || h === 'weekend'),
    site: find((h) => h.startsWith('sitelabor') || h === 'site'),
    overhead: find((h) => h.startsWith('overhead') || h === 'oh'),
    holiday: find((h) => h.startsWith('statholidaylabor') || h.startsWith('holidaylabor') || h.startsWith('holidaypay') || h === 'hol'),
  }
  const days = { school_days: find((h) => h.startsWith('school')), staff_days: find((h) => h.startsWith('staff')), closure_days: find((h) => h.startsWith('closure')),
    summer_days: find((h) => h.startsWith('summer')), stat_holidays: find((h) => h === 'stat' || h === 'statholidays' || h === 'statdays') }
  const weeks: BudgetWeekRow[] = []
  for (const cells of table.slice(headerAt + 1)) {
    const label = (cells[at.week] ?? '').trim()
    const week = parseDay(label)
    if (!week) { if (label) skipped.push(label); continue }
    if (!isSunday(week)) errors.push(`${label}: weeks end on a Sunday`)
    const amount = (i: number, name: string) => {
      const n = i >= 0 ? parseAmount(cells[i] ?? '') : null
      if (Number.isNaN(n) || (n != null && n < 0)) { errors.push(`${label}: ${name} "${cells[i]}" is not an amount`); return 0 }
      return n ?? 0
    }
    const row: BudgetWeekRow = { week_end: week, site_labor: amount(at.site, 'site labor'), overhead_labor: amount(at.overhead, 'overhead labor'), holiday_labor: amount(at.holiday, 'stat holiday labor'), details: {} }
    for (const [key, i] of Object.entries(days)) {
      const n = i >= 0 ? parseAmount(cells[i] ?? '') : null
      if (n != null && !Number.isNaN(n)) row.details[key as keyof BudgetRow['details']] = n
    }
    if (weeks.some((w) => w.week_end === week)) errors.push(`${label}: week appears twice`)
    weeks.push(row)
  }
  if (at.site < 0 && at.overhead < 0) errors.push('No Site labor or Overhead labor column')
  if (!weeks.length && !errors.length) errors.push('No week rows under the header')
  return { kind: 'weeks', rows: [], weeks, errors, skipped }
}

export function parseBudget(text: string): ParsedBudget {
  const table = splitTable(text)
  const errors: string[] = [], skipped: string[] = []
  const weekAt = table.findIndex((r) => r.some((c) => ['weekending', 'week', 'weekend'].includes(compact(c))))
  if (weekAt >= 0) return parseWeeks(table, weekAt)
  const headerAt = table.findIndex((r) => r.some((c) => compact(c) === 'month') && r.some((c) => compact(c).startsWith('sitelabor') || compact(c).startsWith('overheadlabor')))
  if (headerAt < 0) return { kind: 'months', rows: [], weeks: [], errors: ['No header row with Month (or Week ending) and Site labor or Overhead labor'], skipped }
  const header = table[headerAt].map(compact)
  const index = new Map<string, number>()
  for (const col of COLUMNS) {
    const i = header.findIndex((h) => col.test(h))
    if (i >= 0 && !index.has(col.key)) index.set(col.key, i)
  }
  const rows: BudgetRow[] = []
  for (const cells of table.slice(headerAt + 1)) {
    const cell = (key: string) => (index.has(key) ? cells[index.get(key)!] ?? '' : '')
    const label = cell('month').trim()
    const month = parseMonth(label)
    if (!month) { if (label) skipped.push(label); continue }
    const row: BudgetRow = { month, site_labor: null, overhead_labor: null, revenue: null, supplies: null, details: {} }
    for (const key of ['site_labor', 'overhead_labor', 'revenue', 'supplies'] as const) {
      const n = parseAmount(cell(key))
      if (Number.isNaN(n) || (n != null && n < 0)) errors.push(`${label}: ${key.replace('_', ' ')} "${cell(key)}" is not an amount`)
      else row[key] = n
    }
    for (const col of COLUMNS) {
      if (!col.key.startsWith('d:')) continue
      const n = parseAmount(cell(col.key))
      if (n != null && !Number.isNaN(n)) row.details[col.key.slice(2) as keyof BudgetRow['details']] = n
    }
    const total = parseAmount(cell('total'))
    if (total != null && !Number.isNaN(total) && row.site_labor != null && row.overhead_labor != null && Math.abs(row.site_labor + row.overhead_labor - total) > 2)
      errors.push(`${label}: site + overhead (${row.site_labor + row.overhead_labor}) does not equal total labor (${total})`)
    if (row.site_labor == null && row.overhead_labor == null) errors.push(`${label}: no site or overhead labor`)
    if (rows.some((r) => r.month === month)) errors.push(`${label}: month appears twice`)
    rows.push(row)
  }
  if (!rows.length && !errors.length) errors.push('No month rows under the header')
  return { kind: 'months', rows, weeks: [], errors, skipped }
}
