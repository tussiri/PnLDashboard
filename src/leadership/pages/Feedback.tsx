import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useApiQuery } from '../../hooks/useApiQuery'
import type { FeedbackOverview, FeedbackSentiment, LeadershipAccount, LeadershipFeedbackResponse } from '../../services/apiTypes'
import { queryKey } from '../../services/queryClient'
import { formatRoute, monthLabel, monthShort } from '../routes'
import { useLeadership } from '../state'
import { Empty, Kpi, LoadError, Skeleton, SortTable, type Column } from '../ui'
import { ServiceTickets } from './ServiceTickets'

type Line = LeadershipFeedbackResponse['lines'][number]
type Site = LeadershipFeedbackResponse['by_site'][number]

export const stars = (score: number | null) => (score == null ? '–' : score.toFixed(score % 1 ? 1 : 0))
export const scoreTone = (score: number | null) => (score == null ? '' : score <= 2 ? 'bad' : score < 4 ? 'warn' : 'ok')
const MONTHS = 12

/** "JANITORIAL DOCK" -> "Dock". */
export const tradeName = (trade: string | null) => {
  const t = (trade ?? '').replace(/^JANITORIAL\s*/i, '').trim().toLowerCase()
  return t ? t[0].toUpperCase() + t.slice(1) : '–'
}

/** One visit: the ratings a station gave on one date. FedEx rates each trade (dock, office, pallets) as its own
 * work order and often repeats one comment on each; a visit lists every trade's score and each distinct comment once.
 * Averages elsewhere still count every rating. */
export interface Visit {
  key: string; feedback_date: string; location_number: string; site_name: string | null; company: string | null; job_number: string | null
  ratings: { trade: string | null; score: number | null; wo_number: string }[]; comments: string[]; average: number | null; low: boolean
}
// Placeholders the export writes for a blank comment (as the importer's NO_COMMENT, after dropping punctuation).
const NO_COMMENT = new Set(['', 'nocomment', 'nocomments', 'na', 'none'])
export function groupVisits(lines: Line[]): Visit[] {
  const out = new Map<string, Visit>()
  for (const l of lines) {
    const key = `${l.location_number}|${l.feedback_date}`
    const v = out.get(key) ?? { key, feedback_date: l.feedback_date, location_number: l.location_number, site_name: l.site_name, company: l.company,
      job_number: l.job_number, ratings: [], comments: [], average: null, low: false }
    v.ratings.push({ trade: l.trade, score: l.score, wo_number: l.wo_number })
    const c = l.comment?.trim()
    if (c && !NO_COMMENT.has(c.toLowerCase().replace(/[^a-z0-9]/g, '')) && !v.comments.some((x) => x.toLowerCase() === c.toLowerCase())) v.comments.push(c)
    out.set(key, v)
  }
  for (const v of out.values()) {
    const scored = v.ratings.filter((r) => r.score != null)
    v.average = scored.length ? scored.reduce((t, r) => t + r.score!, 0) / scored.length : null
    v.low = scored.some((r) => r.score! <= 2)
    v.ratings.sort((a, b) => (a.trade ?? '').localeCompare(b.trade ?? ''))
  }
  return [...out.values()]
}
export const visitScores = (v: Visit) => v.ratings.map((r) => <span key={r.wo_number} className={`vs ${scoreTone(r.score)}`}>{tradeName(r.trade)} {stars(r.score)}</span>)

/** A site's star ratings by month: average, ratings and 1-2 star ratings per month, and over the whole window. */
export interface MatrixSite {
  key: string; name: string; location_number: string; company: string | null; job_number: string | null
  months: Record<string, { average: number; ratings: number; low: number }>; average: number | null; ratings: number; low: number
}

/** The months from `since` (YYYY-MM-DD) through the month of the newest rating, oldest first, as YYYY-MM-01. */
export function matrixMonths(since: string, lines: { feedback_date: string }[]): string[] {
  const last = lines.reduce((m, l) => (l.feedback_date > m ? l.feedback_date : m), since).slice(0, 7)
  const out: string[] = []
  let [y, m] = since.slice(0, 7).split('-').map(Number)
  while (`${y}-${String(m).padStart(2, '0')}` <= last) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`)
    if (++m > 12) { m = 1; y++ }
  }
  return out
}

/** One row per site (its WinTeam job, else its ServiceChannel location), lowest average first. Every rating counts. */
export function ratingMatrix(lines: Line[]): MatrixSite[] {
  const sites = new Map<string, MatrixSite & { total: number; scored: number }>()
  for (const l of lines) {
    const key = l.company && l.job_number ? `${l.company}|${l.job_number}` : `loc|${l.location_number}`
    const s = sites.get(key) ?? { key, name: l.site_name ?? `Location ${l.location_number}`, location_number: l.location_number, company: l.company,
      job_number: l.job_number, months: {}, average: null, ratings: 0, low: 0, total: 0, scored: 0 }
    sites.set(key, s)
    s.ratings++
    if (l.score == null) continue
    const month = `${l.feedback_date.slice(0, 7)}-01`
    const cell = s.months[month] ?? { average: 0, ratings: 0, low: 0 }
    cell.average = (cell.average * cell.ratings + l.score) / (cell.ratings + 1)
    cell.ratings++; cell.low += l.score <= 2 ? 1 : 0
    s.months[month] = cell
    s.total += l.score; s.scored++; s.low += l.score <= 2 ? 1 : 0
  }
  return [...sites.values()].map(({ total, scored, ...s }) => ({ ...s, average: scored ? total / scored : null }))
    .sort((a, b) => (a.average ?? 99) - (b.average ?? 99) || b.ratings - a.ratings || a.name.localeCompare(b.name))
}

/** Star rating by site and month, worst first. Shows `initial` sites and adds `step` more per click; the filter searches every site. */
export function RatingMatrix({ lines, since, initial = 15, step = 25, title = 'Star rating by site', action }: {
  lines: Line[]; since: string; initial?: number; step?: number; title?: string; action?: ReactNode
}) {
  const { navigate } = useLeadership()
  const [shown, setShown] = useState(initial)
  const [filter, setFilter] = useState('')
  const months = useMemo(() => matrixMonths(since, lines), [since, lines])
  const all = useMemo(() => ratingMatrix(lines), [lines])
  const q = filter.trim().toLowerCase()
  const rows = q ? all.filter((s) => s.name.toLowerCase().includes(q) || s.location_number.toLowerCase().includes(q) || (s.job_number ?? '').includes(q)) : all
  const visible = rows.slice(0, shown)
  const open = (s: MatrixSite) => s.company && s.job_number && navigate({ site: { company: s.company, job: s.job_number } })
  if (!all.length) return null
  return <div className="card">
    <div className="ct"><span>{title}, {months.length === 1 ? monthLabel(months[0]) : `${monthLabel(months[0])} to ${monthLabel(months.at(-1)!)}`}</span>
      <span className="ctrl">{action}<label htmlFor="rm-q" className="sr-only">Search sites</label>
        <input id="rm-q" type="search" placeholder="Search site or location" value={filter} onChange={(e) => { setFilter(e.target.value); setShown(initial) }} /></span></div>
    <div className="tw"><table className="heat-grid">
      <thead><tr><th className="nosort l">Site</th><th className="nosort l">Location</th>{months.map((m) => <th key={m} className="nosort">{monthShort(m)}</th>)}
        <th className="nosort">Average</th><th className="nosort">Ratings</th><th className="nosort">1-2 stars</th></tr></thead>
      <tbody>{visible.map((s) => <tr key={s.key} className={s.job_number ? 'click' : undefined} onClick={() => open(s)}
        tabIndex={s.job_number ? 0 : undefined} onKeyDown={(e) => { if (e.key === 'Enter') open(s) }}>
        <td className="l nm" title={s.name}>{s.name}</td><td className="l">{s.location_number}</td>
        {months.map((m) => { const c = s.months[m]; return <td key={m} className={c ? `heat ${scoreTone(c.average)}` : 'neutral'}
          title={c ? `${c.ratings} rating${c.ratings === 1 ? '' : 's'}${c.low ? `, ${c.low} at 1-2 stars` : ''}` : undefined}>{c ? c.average.toFixed(1) : '–'}</td> })}
        <td className={scoreTone(s.average)}><b>{s.average == null ? '–' : s.average.toFixed(2)}</b></td><td>{s.ratings}</td><td className={s.low ? 'bad' : ''}>{s.low}</td>
      </tr>)}</tbody>
    </table></div>
    <div className="more-row"><span>{visible.length} of {rows.length} sites</span>
      {rows.length > visible.length && <button type="button" className="linkbtn" onClick={() => setShown((n) => n + step)}>Show {Math.min(step, rows.length - visible.length)} more</button>}</div>
  </div>
}

/** Customer feedback and star ratings at the account's sites (the ServiceChannel feedback export). */
export function Feedback({ account }: { account: LeadershipAccount }) {
  const { api, keyPrefix, decision, navigate } = useLeadership()
  const q = useApiQuery<LeadershipFeedbackResponse>(decision ? queryKey(`${keyPrefix}/leadership/feedback`, { account: account.slug, months: MONTHS }) : null,
    (signal) => api.leadershipFeedback(account.slug, MONTHS, signal), [api, account.slug])
  if (q.error) return <LoadError error={q.error} onRetry={q.refetch} />
  if (!q.data) return <Skeleton height={320} />
  const d = q.data
  if (!d.lines.length) return <Empty>No feedback since {monthLabel(d.since)}.</Empty>
  const open = (r: { company: string | null; job_number: string | null }) => r.company && r.job_number && navigate({ site: { company: r.company, job: r.job_number } })
  const siteName = (r: { site_name: string | null; location_number: string }) => r.site_name ?? `Location ${r.location_number}`
  const siteCols: Column<Site>[] = [
    { key: 'site', header: 'Site', left: true, value: siteName, className: 'nm' },
    { key: 'loc', header: 'Location', left: true, value: (r) => r.location_number },
    { key: 'avg', header: 'Avg rating', value: (r) => r.average, render: (r) => <span className={scoreTone(r.average)}>{stars(r.average)}</span> },
    { key: 'n', header: 'Ratings', value: (r) => r.ratings },
    { key: 'low', header: '1-2 stars', value: (r) => r.low, render: (r) => <span className={r.low ? 'bad' : ''}>{r.low}</span> },
    { key: 'last', header: 'Latest', left: true, value: (r) => r.latest_date ?? '' },
    { key: 'comment', header: 'Latest comment', left: true, value: (r) => r.latest_comment ?? '', className: 'wrap' },
  ]
  const visits = groupVisits(d.lines)
  const visitCols: Column<Visit>[] = [
    { key: 'date', header: 'Date', left: true, value: (r) => r.feedback_date },
    { key: 'site', header: 'Site', left: true, value: siteName, className: 'nm' },
    { key: 'loc', header: 'Location', left: true, value: (r) => r.location_number },
    { key: 'score', header: 'Ratings', value: (r) => r.average, render: visitScores,
      csv: (r) => r.ratings.map((x) => `${tradeName(x.trade)} ${stars(x.score)}`).join('; ') },
    { key: 'comment', header: 'Comment', left: true, value: (r) => r.comments.join(' / '), className: 'wrap' },
    { key: 'wo', header: 'Work orders', left: true, value: (r) => r.ratings.map((x) => x.wo_number).join(', '), className: 'neutral' },
  ]
  return <>
    <TabSentiment account={account} names={siteNames(d.lines)} />
    <div className="kpi-lg">
      <Kpi label="Avg rating" value={<>{stars(d.average)}<span className="of"> / 5</span></>} tone={scoreTone(d.average)} sub={`Since ${monthLabel(d.since)}`} />
      <Kpi label="Ratings" value={d.ratings.toLocaleString('en-US')} sub={`${d.sites} sites`} />
      <Kpi label="1-2 stars" value={d.low.toLocaleString('en-US')} tone={d.low ? 'bad' : 'ok'} sub={d.ratings ? `${Math.round((d.low / d.ratings) * 100)}% of ratings` : undefined} />
      <Kpi label="Unmatched locations" value={d.unmatched.toLocaleString('en-US')} tone={d.unmatched ? 'warn' : ''} sub="No WinTeam job" />
    </div>
    <ServiceTickets account={account} />
    <RatingMatrix lines={d.lines} since={d.since} initial={50} step={50} />
    <div className="card"><div className="ct"><span>By site</span></div>
      <SortTable caption="Feedback by site" rows={d.by_site} columns={siteCols} defaultSort={{ key: 'avg', dir: 1 }} pageSize={25}
        onRowClick={open} rowLabel={(r) => `Open ${siteName(r)}`} csvName={`${account.slug}-feedback-by-site`} /></div>
    <div className="card"><div className="ct"><span>Visits</span><span className="ks">{visits.length.toLocaleString('en-US')} visits, {d.ratings.toLocaleString('en-US')} ratings</span></div>
      <SortTable caption="Feedback by visit" rows={visits} columns={visitCols} defaultSort={{ key: 'date', dir: -1 }} pageSize={50}
        onRowClick={open} rowLabel={(r) => `Open ${siteName(r)}`} csvName={`${account.slug}-feedback`} /></div>
  </>
}

const SENTIMENT: Record<FeedbackSentiment, { label: string; tone: string }> = {
  positive: { label: 'Positive', tone: 'ok' }, mixed: { label: 'Mixed', tone: 'warn' }, negative: { label: 'Negative', tone: 'bad' } }
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`

/** A site's name without the customer's prefixes: "FedEx - Tracy, CA" -> "Tracy, CA", and the ServiceChannel
 * location codes "FXG_854 / 3854 Lake Havasu City AZ" -> "Lake Havasu City AZ", "FXE_EWNA New Bern NC" -> "New Bern NC".
 * A name that is only a code stays as it is. */
export const siteShort = (name: string) => {
  const n = name.replace(/^FedEx\s*-\s*/i, '').replace(/^FX[A-Z]?[_-][A-Z0-9]+(\s*\/\s*\d+)?\s+/i, '').trim()
  return /^FX[A-Z]?[_-][A-Z0-9]+$/i.test(n) ? n.replace(/^FX[A-Z]?[_-]/i, '') : n || name
}

/** Location code to site name, from the account's feedback lines. */
export function siteNames(lines: { location_number: string; site_name: string | null }[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const l of lines) if (l.site_name && !out.has(l.location_number)) out.set(l.location_number, siteShort(l.site_name))
  return out
}

/** A theme's sites by name: the first three, then how many more. */
export function themeSites(locations: string[], names: Map<string, string>, shown = 3): string {
  const all = [...new Set(locations)].map((c) => names.get(c) ?? c)
  return all.length > shown ? `${all.slice(0, shown).join(', ')}, ${all.length - shown} more` : all.join(', ')
}

/** The account's feedback overview (scores and the comment summary), refetched while the summary is being rebuilt. */
function useFeedbackOverview(account: LeadershipAccount, month: string | undefined) {
  const { api, keyPrefix, decision } = useLeadership()
  const q = useApiQuery<FeedbackOverview>(decision ? queryKey(`${keyPrefix}/leadership/feedback/overview`, { account: account.slug, month }) : null,
    (signal) => api.leadershipFeedbackOverview(account.slug, month, signal), [api, account.slug, month])
  const pending = q.data?.summary.status === 'pending'
  useEffect(() => {
    if (!pending) return
    const t = window.setTimeout(() => q.refetch(), 15_000)
    return () => window.clearTimeout(t)
  }, [pending, q])
  return q
}

/** The months from `since` through `last` (both YYYY-MM-..), oldest first, as YYYY-MM-01. */
export function monthAxis(since: string, last: string): string[] {
  const out: string[] = []
  let [y, m] = since.slice(0, 7).split('-').map(Number)
  while (`${y}-${String(m).padStart(2, '0')}` <= last.slice(0, 7)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`)
    if (++m > 12) { m = 1; y++ }
  }
  return out
}

/** Claude's read of the recent comments across the sites: sentiment, headline and a table of themes with the sites behind each. */
function SentimentBlock({ overview: { summary: s }, names }: { overview: FeedbackOverview; names: Map<string, string> }) {
  if (s.status === 'pending' && !s.summary) return <div className="fbs"><div className="fbs__hd"><span className="kl">Sentiment by site</span><span className="badge bnone">Updating</span></div></div>
  if (s.status !== 'ready' || !s.summary) return null
  const mood = SENTIMENT[s.summary.sentiment]
  return <div className="fbs" title={`Claude's read of ${s.comments} comments from the ${s.window_days} days up to the newest rating`}>
    <div className="fbs__hd"><span className="kl">Sentiment by site, last {Math.round((s.window_days ?? 90) / 30)} months</span>
      <span className={`badge b${mood.tone}`}>{mood.label}</span><span className="ks fbs__n">{s.comments} comments</span></div>
    <p className="fbs__line">{s.summary.headline}</p>
    {s.summary.themes.length > 0 && <table className="fbs__themes">
      <thead><tr><th className="l">Theme</th><th className="l">Sites</th><th>Comments</th></tr></thead>
      <tbody>{s.summary.themes.map((t) => <tr key={t.theme}>
        <td className={`l fbs__theme ${SENTIMENT[t.sentiment].tone}`}>{t.theme}</td>
        <td className="l fbs__sites" title={themeSites(t.locations, names, 99)}>{themeSites(t.locations, names)}</td>
        <td className="num">{t.mentions}</td></tr>)}</tbody>
    </table>}
  </div>
}

/** The Feedback tab's sentiment; the summary covers the newest ratings whatever month is picked. */
function TabSentiment({ account, names }: { account: LeadershipAccount; names: Map<string, string> }) {
  const q = useFeedbackOverview(account, undefined)
  return q.data && q.data.summary.status === 'ready' ? <div className="card fbc"><SentimentBlock overview={q.data} names={names} /></div> : null
}

/** Monthly averages sit between 3 and 5 stars: the strip starts at 3 so a month's move shows (exact values on hover). */
const STRIP_FLOOR = 3
/** Average star rating by month over the 12 months; a month without ratings is an empty slot. */
function RatingStrip({ months, latest }: { months: { month: string; average: number | null; ratings: number }[]; latest: string | null }) {
  return <div className="fbc__strip" role="img" aria-label={`Average star rating by month: ${months.map((m) => `${monthShort(m.month)} ${m.average == null ? 'no ratings' : stars(m.average)}`).join(', ')}`}>
    {months.map((m) => <div key={m.month} className={`fbc__col${m.month === latest ? ' on' : ''}`} title={m.average == null ? `${monthLabel(m.month)}: no ratings` : `${monthLabel(m.month)}: ${m.average.toFixed(2)} from ${m.ratings} ratings`}>
      <div className="fbc__bar"><span className={scoreTone(m.average)} style={{ height: m.average == null ? 0 : `${Math.max(6, Math.min(100, ((m.average - STRIP_FLOOR) / (5 - STRIP_FLOOR)) * 100))}%` }} /></div>
      <span className="fbc__m">{monthShort(m.month).slice(0, 1)}</span>
    </div>)}
  </div>
}

/** The average star rating over the given months, weighted by each month's scored ratings; null without any. */
export function recentScore(months: { average: number | null; scored: number }[]): number | null {
  const scored = months.reduce((t, m) => t + (m.average == null ? 0 : m.scored), 0)
  return scored ? Math.round((months.reduce((t, m) => t + (m.average ?? 0) * m.scored, 0) / scored) * 100) / 100 : null
}

/** The account's site feedback at a glance, at the top of its overview: the star rating over the last three rated
 * months beside the 12 months by month, the
 * latest rated month, 1-2 stars over the last three rated months and the lowest rated sites, beside Claude's read of
 * the last 90 days of comments. */
export function FeedbackTile({ account, month, lines = [] }: { account: LeadershipAccount; month: string | undefined
  /** The account's feedback lines, to name the sites behind each theme. */
  lines?: Line[] }) {
  const { navigate } = useLeadership()
  const q = useFeedbackOverview(account, month)
  const names = useMemo(() => siteNames(lines), [lines])
  const d = q.data
  if (q.error || !d || !d.year.ratings) return null
  const byMonth = new Map(d.months.map((m) => [m.month.slice(0, 7), m]))
  const axis = monthAxis(d.year.since, d.month).slice(-12).map((m) => {
    const x = byMonth.get(m.slice(0, 7))
    return { month: m, average: x?.average ?? null, ratings: x?.ratings ?? 0, scored: x?.scored ?? 0, low: x?.low ?? 0 }
  })
  // The ratings lag the calendar: lead with the newest month that has any, against the rated month before it.
  const rated = axis.filter((m) => m.average != null)
  const latest = rated.at(-1) ?? null
  const before = rated.at(-2) ?? null
  const change = latest && before ? latest.average! - before.average! : null
  const recent = rated.slice(-3)
  const recentLow = recent.reduce((t, m) => t + m.low, 0)
  const recentRatings = recent.reduce((t, m) => t + m.ratings, 0)
  const recentAverage = recentScore(recent)
  const critical = d.critical_sites ?? []
  const open = (c: { company: string | null; job_number: string | null }) => c.company && c.job_number && navigate({ site: { company: c.company, job: c.job_number } })
  const href = formatRoute({ view: 'account', account: account.slug, tab: 'feedback' })
  const hasSentiment = d.summary.status === 'ready' || d.summary.status === 'pending'
  return <section className="card fbc" aria-label={`${account.name} site feedback`}>
    <div className="ct"><span>Site feedback</span><a className="ks" href={href}>All feedback</a></div>
    <div className={`fbc__grid${hasSentiment ? '' : ' solo'}`}>
      <div className="fbc__score">
        <div className="fbc__top">
          <div><div className="kl">Star rating, last {recent.length || 3} months</div>
            <div className={`fbc__big ${scoreTone(recentAverage)}`}>{stars(recentAverage)}<span className="of"> / 5</span></div>
            <div className="ks">{recentRatings.toLocaleString('en-US')} ratings{recent.length ? `, ${monthShort(recent[0].month)} to ${monthShort(recent.at(-1)!.month)}` : ''}</div></div>
          <RatingStrip months={axis} latest={latest?.month ?? null} />
        </div>
        <dl className="fbc__facts">
          <div><dt>{latest ? monthLabel(latest.month) : 'Latest month'}</dt>
            <dd className={scoreTone(latest?.average ?? null)}>{latest ? stars(latest.average) : '–'}</dd>
            <dd className="ks">{latest ? `${latest.ratings} ratings${change != null ? `, ${signed(change)} vs ${monthShort(before!.month)}` : ''}` : 'No ratings'}</dd></div>
          <div><dt>1-2 stars, last {recent.length || 3} months</dt>
            <dd className={recentLow ? 'bad' : 'ok'}>{recentLow}</dd>
            <dd className="ks">{recentRatings ? `${Math.round((recentLow / recentRatings) * 100)}% of ${recentRatings} ratings` : 'No ratings'}</dd></div>
        </dl>
        {critical.length > 0 && <div className="fbc__low"><div className="kl">Lowest rated, last 3 months</div>
          <ul>{critical.map((c) => <li key={c.location_number}>
            <button type="button" className="linkbtn" disabled={!c.job_number} onClick={() => open(c)}>{siteShort(c.site_name ?? c.location_number)}</button>
            <span className="ks">{c.ratings} ratings</span><b className={scoreTone(c.average)}>{stars(c.average)}</b></li>)}</ul></div>}
      </div>
      {hasSentiment && <SentimentBlock overview={d} names={names} />}
    </div>
  </section>
}
