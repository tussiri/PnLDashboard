/**
 * The Feedback explorer's slicing (FeedbackExplorer.tsx). Every average is the mean of the individual ratings in the
 * slice (each trade's work order counts once), never an average of averages, and every figure carries its count.
 */
import type { LeadershipFeedbackLine } from '../services/apiTypes'

export type Line = LeadershipFeedbackLine
export const DIMENSIONS = ['region', 'subregion', 'opco', 'delivery', 'trade', 'provider', 'site', 'month'] as const
export type Dimension = (typeof DIMENSIONS)[number]
export const DIMENSION_LABEL: Record<Dimension, string> = {
  region: 'Region', subregion: 'Subregion', opco: 'OPCO', delivery: 'Delivery', trade: 'Trade', provider: 'Provider', site: 'Site', month: 'Month',
}
export const SCORE_BANDS = { all: 'All scores', low: '1-2 stars', mid: '3 stars', high: '4-5 stars' } as const
export type ScoreBand = keyof typeof SCORE_BANDS

const NONE = 'None'
const tradeOf = (t: string | null) => { const s = (t ?? '').replace(/^JANITORIAL\s*/i, '').trim().toLowerCase(); return s ? s[0].toUpperCase() + s.slice(1) : NONE }
const siteOf = (l: Line) => l.site_name ?? `Location ${l.location_number}`

/** A line's value on a dimension, as shown and filtered. */
export function valueOf(l: Line, d: Dimension): string {
  switch (d) {
    case 'region': return l.region || NONE
    case 'subregion': return l.subregion || NONE
    case 'opco': return l.opco || NONE
    case 'delivery': return l.delivery_model === 'self_perform' ? 'Self-performed' : l.delivery_model === 'subcontracted' ? 'Subcontracted' : NONE
    case 'trade': return tradeOf(l.trade)
    case 'provider': return (l.provider_name ?? '').trim() || NONE
    case 'site': return siteOf(l)
    case 'month': return l.feedback_date.slice(0, 7)
  }
}

export interface Filters { values: Partial<Record<Dimension, string>>; score: ScoreBand; comments: boolean; search: string; days: number | null }
export const EMPTY_FILTERS: Filters = { values: {}, score: 'all', comments: false, search: '', days: null }

const inBand = (s: number | null, band: ScoreBand) => band === 'all' || (s != null && (band === 'low' ? s <= 2 : band === 'mid' ? s > 2 && s < 4 : s >= 4))

/** The lines in the slice. `days` counts back from the newest rating loaded (not today), so a quiet week does not empty it. */
export function filterLines(lines: Line[], f: Filters): Line[] {
  const latest = lines.reduce((m, l) => (l.feedback_date > m ? l.feedback_date : m), '')
  const since = f.days && latest ? addDays(latest, -f.days + 1) : null
  const q = f.search.trim().toLowerCase()
  return lines.filter((l) => (!since || l.feedback_date >= since)
    && Object.entries(f.values).every(([d, v]) => !v || valueOf(l, d as Dimension) === v)
    && inBand(l.score, f.score) && (!f.comments || Boolean(l.comment?.trim()))
    && (!q || `${siteOf(l)} ${l.location_number} ${l.comment ?? ''}`.toLowerCase().includes(q)))
}

/** The values a dimension takes across the lines, most ratings first. */
export function options(lines: Line[], d: Dimension): { value: string; n: number }[] {
  const m = new Map<string, number>()
  for (const l of lines) m.set(valueOf(l, d), (m.get(valueOf(l, d)) ?? 0) + 1)
  return [...m].map(([value, n]) => ({ value, n })).sort((a, b) => (d === 'month' ? b.value.localeCompare(a.value) : b.n - a.n || a.value.localeCompare(b.value)))
}

export interface Stats { ratings: number; scored: number; average: number | null; low: number; lowShare: number | null; sites: number; comments: number; latest: string | null }

export function stats(lines: Line[]): Stats {
  let total = 0, scored = 0, low = 0, comments = 0, latest: string | null = null
  const sites = new Set<string>()
  for (const l of lines) {
    if (l.score != null) { total += l.score; scored += 1; if (l.score <= 2) low += 1 }
    if (l.comment?.trim()) comments += 1
    sites.add(l.location_number)
    if (!latest || l.feedback_date > latest) latest = l.feedback_date
  }
  return { ratings: lines.length, scored, average: scored ? total / scored : null, low, lowShare: scored ? low / scored : null, sites: sites.size, comments, latest }
}

export interface GroupRow extends Stats { key: string; recent: number | null; recentN: number; prior: number | null; change: number | null }

/** One row per group value: totals, the running average over the last `window` days (to the newest rating) and the
 * window before it, and the change between them. */
export function groupRows(lines: Line[], d: Dimension, window: number): GroupRow[] {
  const latest = lines.reduce((m, l) => (l.feedback_date > m ? l.feedback_date : m), '')
  const cut = latest ? addDays(latest, -window + 1) : '', cutPrior = latest ? addDays(latest, -2 * window + 1) : ''
  const groups = new Map<string, Line[]>()
  for (const l of lines) { const k = valueOf(l, d); const g = groups.get(k); if (g) g.push(l); else groups.set(k, [l]) }
  return [...groups].map(([key, ls]) => {
    const recent = stats(ls.filter((l) => l.feedback_date >= cut)), prior = stats(ls.filter((l) => l.feedback_date >= cutPrior && l.feedback_date < cut))
    return { key, ...stats(ls), recent: recent.average, recentN: recent.scored, prior: prior.average,
      change: recent.average != null && prior.average != null ? recent.average - prior.average : null }
  })
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Weekly points (Sundays) from the first rating to the newest, each the average of the ratings in the `window` days
 * ending that day, for every series (null where a window holds none). */
export function rollingSeries(series: { label: string; lines: Line[] }[], window: number): { labels: string[]; series: { label: string; data: (number | null)[]; counts: number[] }[] } {
  const all = series.flatMap((s) => s.lines)
  if (!all.length) return { labels: [], series: [] }
  const first = all.reduce((m, l) => (l.feedback_date < m ? l.feedback_date : m), all[0].feedback_date)
  const last = all.reduce((m, l) => (l.feedback_date > m ? l.feedback_date : m), all[0].feedback_date)
  const points: string[] = []
  let p = addDays(first, (7 - new Date(`${first}T00:00:00Z`).getUTCDay()) % 7)
  while (p < last) { points.push(p); p = addDays(p, 7) }
  points.push(last)
  return { labels: points, series: series.map((s) => {
    const scored = s.lines.filter((l) => l.score != null).map((l) => ({ d: l.feedback_date, s: l.score as number })).sort((a, b) => a.d.localeCompare(b.d))
    const data: (number | null)[] = [], counts: number[] = []
    for (const point of points) {
      const from = addDays(point, -window + 1)
      let sum = 0, n = 0
      for (const r of scored) { if (r.d > point) break; if (r.d >= from) { sum += r.s; n += 1 } }
      data.push(n ? sum / n : null); counts.push(n)
    }
    return { label: s.label, data, counts }
  }) }
}
