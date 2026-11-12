/**
 * The Feedback tab's filters and figures, computed in the browser from GET /leadership/feedback (24 months of
 * ratings) and GET /leadership/service-tickets. Pure functions so the view and the tests share them.
 */
import type { LeadershipFeedbackLine, ServiceTicket } from '../services/apiTypes'

export type Trade = 'Dock' | 'Office' | 'Pallets' | 'Other'
export type Delivery = 'self_perform' | 'subcontracted' | 'unmapped'
export const TRADES: Trade[] = ['Dock', 'Office', 'Pallets']
export const DELIVERY_LABEL: Record<Delivery, string> = { self_perform: 'Self-perform', subcontracted: 'Subcontracted', unmapped: 'Unmapped' }
export const OPCO_LABEL: Record<string, string> = { FXG: 'Ground', FXE: 'Express' }

/** One scored rating, flattened for filtering. `key` is the site: its WinTeam job, else its location. */
export interface Rating {
  date: string; month: string; loc: string; key: string; site: string; company: string | null; job: string | null
  region: string; opco: string | null; delivery: Delivery; trade: Trade; score: number; comment: string | null
}

// Placeholders the export writes for a blank comment (as the importer's NO_COMMENT, after dropping punctuation).
const NO_COMMENT = new Set(['', 'nocomment', 'nocomments', 'na', 'none'])
export const cleanComment = (c: string | null | undefined) => {
  const t = (c ?? '').trim()
  return t && !NO_COMMENT.has(t.toLowerCase().replace(/[^a-z0-9]/g, '')) ? t : null
}
/** Location codes compare upper case without leading zeros (as core.feedback_location). */
export const normLoc = (s: string) => s.toUpperCase().trim().replace(/^0+(?=.)/, '')
const siteKey = (company: string | null, job: string | null, loc: string) => (company && job ? `${company}|${job}` : `loc|${normLoc(loc)}`)
const tradeOf = (t: string | null): Trade => {
  const x = (t ?? '').replace(/^JANITORIAL\s*/i, '').trim().toLowerCase()
  return x === 'dock' ? 'Dock' : x === 'office' ? 'Office' : x === 'pallets' ? 'Pallets' : 'Other'
}

export function toRatings(lines: LeadershipFeedbackLine[]): Rating[] {
  return lines.filter((l) => l.score != null).map((l) => ({
    date: l.feedback_date, month: l.feedback_date.slice(0, 7), loc: l.location_number, key: siteKey(l.company, l.job_number, l.location_number),
    site: l.site_name ?? `Location ${l.location_number}`, company: l.company, job: l.job_number, region: l.region ?? 'Unmapped',
    opco: l.opco ?? null, delivery: (l.delivery_model ?? 'unmapped') as Delivery, trade: tradeOf(l.trade), score: Number(l.score),
    comment: cleanComment(l.comment),
  }))
}

/** Every month (YYYY-MM) from the oldest to the newest rating. */
export function monthList(ratings: { month: string }[]): string[] {
  if (!ratings.length) return []
  let first = ratings[0].month, last = first
  for (const r of ratings) { if (r.month < first) first = r.month; if (r.month > last) last = r.month }
  const out: string[] = []
  let [y, m] = first.split('-').map(Number)
  while (`${y}-${String(m).padStart(2, '0')}` <= last) { out.push(`${y}-${String(m).padStart(2, '0')}`); if (++m > 12) { m = 1; y++ } }
  return out
}

export interface Filters {
  /** Indexes into the month list, inclusive. */
  from: number; to: number
  delivery: 'all' | 'self_perform' | 'subcontracted'; opco: 'all' | 'FXG' | 'FXE'; region: string; trades: Trade[]
  minStars: number; maxStars: number; comments: boolean; q: string
  /** A sentiment theme: comments limited to its sites over the summary's window. */
  theme: number | null
}
export const defaultFilters = (months: number, span = 6): Filters => ({
  from: Math.max(0, months - span), to: Math.max(0, months - 1), delivery: 'all', opco: 'all', region: 'all', trades: [...TRADES],
  minStars: 1, maxStars: 5, comments: false, q: '', theme: null })

interface Scoped { site: string; loc: string; job: string | null; region: string; opco: string | null; delivery: Delivery; trade?: Trade; score?: number }
/** Everything but the period (and, with `stars: false`, the star range), so prior periods and tickets reuse it. */
export function inScope(r: Scoped, f: Filters, { stars = true } = {}): boolean {
  if (f.delivery !== 'all' && r.delivery !== f.delivery) return false
  if (f.opco !== 'all' && r.opco !== f.opco) return false
  if (f.region !== 'all' && r.region !== f.region) return false
  if (r.trade && r.trade !== 'Other' && !f.trades.includes(r.trade)) return false
  if (stars && r.score != null && (r.score < f.minStars || r.score > f.maxStars)) return false
  if (f.q) {
    const q = f.q.toLowerCase()
    if (!r.site.toLowerCase().includes(q) && !r.loc.toLowerCase().includes(q) && !(r.job ?? '').includes(q)) return false
  }
  return true
}
export const inMonths = (month: string | null | undefined, months: string[], from: number, to: number) => !!month && month >= months[from] && month <= months[to]
/** The period of the same length just before, or null when the data does not reach back that far. */
export function priorRange(from: number, to: number): { from: number; to: number } | null {
  const len = to - from + 1
  return from - len >= 0 ? { from: from - len, to: from - 1 } : null
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
export const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
export function groupBy<T>(xs: T[], f: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const x of xs) { const k = f(x); const g = m.get(k); if (g) g.push(x); else m.set(k, [x]) }
  return m
}

export interface Summary { ratings: number; visits: number; average: number | null; low: number; lowRate: number | null; five: number; sites: number; sitesBelow: number }
export function summarize(rows: Rating[]): Summary {
  const sites = groupBy(rows, (r) => r.key)
  const low = rows.filter((r) => r.score <= 2).length
  return { ratings: rows.length, visits: new Set(rows.map((r) => `${r.loc}|${r.date}`)).size, average: mean(rows.map((r) => r.score)), low,
    lowRate: rows.length ? low / rows.length : null, five: rows.filter((r) => r.score === 5).length, sites: sites.size,
    sitesBelow: [...sites.values()].filter((g) => (mean(g.map((r) => r.score)) ?? 5) < 3.5).length }
}

/** By month: ratings, average and the share at 1-2 and at 3 stars. */
export function monthly(rows: Rating[], months: string[]) {
  const by = groupBy(rows, (r) => r.month)
  return months.map((month) => {
    const g = by.get(month) ?? []
    return { month, ratings: g.length, average: mean(g.map((r) => r.score)),
      low: g.length ? g.filter((r) => r.score <= 2).length / g.length : null, three: g.length ? g.filter((r) => r.score === 3).length / g.length : null }
  })
}

export const distribution = (rows: Rating[]) => [5, 4, 3, 2, 1].map((stars) => ({ stars, count: rows.filter((r) => r.score === stars).length }))

/** Visits (a location on a date) with comments, newest first; each distinct comment once, with the visit's lowest score. */
export interface CommentVisit { key: string; date: string; loc: string; site: string; company: string | null; job: string | null; delivery: Delivery
  scores: { trade: Trade; score: number }[]; comments: string[]; min: number }
export function commentVisits(rows: Rating[]): CommentVisit[] {
  const v = new Map<string, CommentVisit>()
  for (const r of rows) {
    if (!r.comment) continue
    const k = `${r.loc}|${r.date}`
    const e = v.get(k) ?? { key: r.key, date: r.date, loc: r.loc, site: r.site, company: r.company, job: r.job, delivery: r.delivery, scores: [], comments: [], min: 5 }
    e.scores.push({ trade: r.trade, score: r.score }); e.min = Math.min(e.min, r.score)
    if (!e.comments.some((c) => c.toLowerCase() === r.comment!.toLowerCase())) e.comments.push(r.comment)
    v.set(k, e)
  }
  return [...v.values()].sort((a, b) => b.date.localeCompare(a.date) || a.site.localeCompare(b.site))
}

/** The `days` up to the newest rating (the sentiment summary's window). */
export function recentWindow(ratings: Rating[], days = 90) {
  const last = ratings.reduce((m, r) => (r.date > m ? r.date : m), '')
  if (!last) return { last, since: '' }
  const d = new Date(`${last}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days)
  return { last, since: d.toISOString().slice(0, 10) }
}

/** A ticket placed on the rated sites: its site key, and the region and delivery model of that site's ratings. */
export interface Ticket extends ServiceTicket { key: string; site: string; loc: string; job: string | null; region: string; delivery: Delivery; rated: boolean; month: string | null }
export function placeTickets(tickets: ServiceTicket[], ratings: Rating[]): Ticket[] {
  const byKey = new Map<string, Rating>(), byLoc = new Map<string, Rating>()
  for (const r of ratings) { if (!byKey.has(r.key)) byKey.set(r.key, r); if (!byLoc.has(normLoc(r.loc))) byLoc.set(normLoc(r.loc), r) }
  return tickets.map((t) => {
    const r = byKey.get(siteKey(t.company, t.job_number, t.location_number)) ?? byLoc.get(normLoc(t.location_number))
    const label = t.location_label ?? t.location_number
    return { ...t, key: r?.key ?? siteKey(t.company, t.job_number, t.location_number), site: r?.site ?? t.site_name ?? (t.city_state ? `${label}, ${t.city_state}` : `Location ${label}`),
      loc: t.location_number, job: r?.job ?? t.job_number, region: r?.region ?? 'Unmapped', delivery: r?.delivery ?? 'unmapped', rated: !!r,
      month: t.date_received?.slice(0, 7) ?? null }
  })
}

const DAY = 86_400_000
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY)

/** Tickets against star ratings: sites with and without a ticket, the location's ratings in the 90 days before a
 * ticket was received and the 90 days after it closed, and the days to close. */
export function ticketStats(rows: Rating[], scopedRatings: Rating[], tickets: Ticket[]) {
  const withKeys = new Set(tickets.map((t) => t.key))
  const site = [...groupBy(rows, (r) => r.key)].map(([key, g]) => ({ key, avg: mean(g.map((r) => r.score))! }))
  const withT = site.filter((s) => withKeys.has(s.key)), without = site.filter((s) => !withKeys.has(s.key))
  const byKey = groupBy(scopedRatings, (r) => r.key)
  const around = tickets.filter((t) => t.rated && t.date_received).map((t) => {
    const g = byKey.get(t.key) ?? [], end = t.date_closed
    const before = g.filter((r) => { const d = daysBetween(r.date, t.date_received!); return d > 0 && d <= 90 }).map((r) => r.score)
    const after = end ? g.filter((r) => { const d = daysBetween(end, r.date); return d > 0 && d <= 90 }).map((r) => r.score) : []
    return { before: mean(before), after: mean(after) }
  })
  const before = around.flatMap((a) => (a.before == null ? [] : [a.before])), after = around.flatMap((a) => (a.after == null ? [] : [a.after]))
  const closed = tickets.filter((t) => t.date_closed && t.date_received).map((t) => daysBetween(t.date_received!, t.date_closed!))
  return { withTicket: { average: mean(withT.map((s) => s.avg)), sites: withT.length }, without: { average: mean(without.map((s) => s.avg)), sites: without.length },
    before: { average: mean(before), tickets: before.length }, after: { average: mean(after), tickets: after.length },
    daysToClose: median(closed), closed: closed.length }
}

export const issueGroup = (type: string | null) => {
  const t = type ?? ''
  return /sow not performed/i.test(t) ? 'SOW not performed' : /invoic/i.test(t) ? 'Invoicing' : /shift|no show|missed/i.test(t) ? 'Missed shifts' : 'Other'
}

/** One row per site for the watchlist. `adjusted` pulls the average toward the filtered average by 5 ratings, so a
 * site with one low rating does not top the list. */
export interface SiteRow { key: string; site: string; loc: string; company: string | null; job: string | null; region: string; delivery: Delivery
  ratings: number; average: number; adjusted: number; low: number; tickets: number; months: Record<string, number>; latest: string | null; latestDate: string
  /** Average change against the prior period; null with fewer than `minPrior` ratings there. */
  change: number | null }
export function siteRows(rows: Rating[], tickets: Ticket[], prior = 5, before: Rating[] | null = null, minPrior = 3): SiteRow[] {
  const overall = mean(rows.map((r) => r.score)) ?? 0
  const tBy = groupBy(tickets, (t) => t.key)
  const pre = before ? groupBy(before, (r) => r.key) : new Map<string, Rating[]>()
  return [...groupBy(rows, (r) => r.key)].map(([key, g]) => {
    const average = mean(g.map((r) => r.score))!
    const months: Record<string, number> = {}
    for (const [m, xs] of groupBy(g, (r) => r.month)) months[m] = mean(xs.map((r) => r.score))!
    const c = g.filter((r) => r.comment).sort((a, b) => b.date.localeCompare(a.date))[0]
    const p = pre.get(key)
    return { key, site: g[0].site, loc: g[0].loc, company: g[0].company, job: g[0].job, region: g[0].region, delivery: g[0].delivery,
      ratings: g.length, average, adjusted: (g.length * average + prior * overall) / (g.length + prior), low: g.filter((r) => r.score <= 2).length,
      tickets: new Set((tBy.get(key) ?? []).map((t) => t.ticket_number)).size, months, latest: c?.comment ?? null,
      latestDate: g.reduce((m, r) => (r.date > m ? r.date : m), ''),
      change: p && p.length >= minPrior ? average - mean(p.map((r) => r.score))! : null }
  })
}
