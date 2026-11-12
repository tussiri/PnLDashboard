import { useMemo, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { FeedbackOverview, LeadershipAccount, LeadershipFeedbackLine, ServiceTicket, ServiceTicketsResponse } from '../../services/apiTypes'
import { useApiQuery } from '../../hooks/useApiQuery'
import { queryKey } from '../../services/queryClient'
import { RatingShareChart, TicketMonthChart } from '../charts'
import {
  DELIVERY_LABEL, OPCO_LABEL, TRADES, commentVisits, defaultFilters, distribution, groupBy, inMonths, inScope, issueGroup, mean, monthList, monthly,
  movers, normLoc, placeTickets, priorRange, recentWindow, siteRows, summarize, ticketStats, toRatings, type Filters, type Mover, type Rating,
  type SiteRow, type Ticket, type Trade,
} from '../feedbackModel'
import { monthLabel, monthShort } from '../routes'
import { useLeadership } from '../state'
import { Empty, Kpi, SortTable, type Column } from '../ui'

const fmt = (n: number) => n.toLocaleString('en-US')
const pct0 = (v: number | null) => (v == null ? '–' : `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`)
const avg2 = (v: number | null) => (v == null ? '–' : v.toFixed(2))
/** Averages: under 2.5 bad, under 4 watch. */
const avgTone = (v: number | null) => (v == null ? '' : v <= 2.5 ? 'bad' : v < 4 ? 'warn' : 'ok')
const starTone = (s: number) => (s <= 2 ? 'bad' : s === 3 ? 'warn' : 'ok')
const mShort = (m: string) => `${monthShort(`${m}-01`)} ${m.slice(2, 4)}`
/** "Jun to Sep 2026", or "Dec 2025 to May 2026" across a year end. */
const monthSpan = (a: string, b: string) => a === b ? monthLabel(`${a}-01`)
  : a.slice(0, 4) === b.slice(0, 4) ? `${monthShort(`${a}-01`)} to ${monthLabel(`${b}-01`)}` : `${monthLabel(`${a}-01`)} to ${monthLabel(`${b}-01`)}`
const dLabel = (d: string) => `${monthShort(d)} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`
const signed = (n: number, digits = 2) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(digits)}`
const PRESETS = [3, 6, 12, 24]
const SENT_TONE = { positive: 'ok', mixed: 'warn', negative: 'bad' } as const

type Overview = FeedbackOverview
type Theme = NonNullable<Overview['summary']['summary']>['themes'][number]

/** The Feedback tab: filters over 24 months of star ratings, with the sentiment summary, movers, service tickets and a site watchlist. */
export function FeedbackBoard({ account, lines, tickets, overview }: { account: LeadershipAccount; lines: LeadershipFeedbackLine[]
  tickets: ServiceTicketsResponse | undefined; overview: Overview | undefined }) {
  const { navigate } = useLeadership()
  const ratings = useMemo(() => toRatings(lines), [lines])
  const months = useMemo(() => monthList(ratings), [ratings])
  const placed = useMemo(() => placeTickets(tickets?.tickets ?? [], ratings), [tickets, ratings])
  const [f, setF] = useState<Filters>(() => defaultFilters(months.length))
  const set = (patch: Partial<Filters>) => setF((x) => ({ ...x, ...patch }))
  const regions = useMemo(() => [...new Set(ratings.map((r) => r.region))].sort(), [ratings])
  const trades = useMemo(() => TRADES.filter((t) => ratings.some((r) => r.trade === t)), [ratings])
  const hasOpco = ratings.some((r) => r.opco)
  const hasDelivery = ratings.some((r) => r.delivery !== 'unmapped')
  const recent = useMemo(() => recentWindow(ratings, overview?.summary.window_days ?? 90), [ratings, overview])
  const themes: Theme[] = overview?.summary.status === 'ready' ? overview.summary.summary?.themes ?? [] : []
  const theme = f.theme != null ? themes[f.theme] ?? null : null

  const v = useMemo(() => {
    const scoped = ratings.filter((r) => inScope(r, f))
    const unstarred = ratings.filter((r) => inScope(r, f, { stars: false }))
    const commentsOnly = (r: Rating) => !f.comments || !!r.comment
    const rows = scoped.filter((r) => inMonths(r.month, months, f.from, f.to) && commentsOnly(r))
    const pr = priorRange(f.from, f.to)
    const prior = pr ? scoped.filter((r) => inMonths(r.month, months, pr.from, pr.to) && commentsOnly(r)) : null
    const tix = placed.filter((t) => inScope(t, f, { stars: false }))
    const periodTix = tix.filter((t) => inMonths(t.month, months, f.from, f.to))
    return { scoped, unstarred, rows, prior, pr, tix, periodTix }
  }, [ratings, months, placed, f])

  if (!months.length) return <Empty>No ratings.</Empty>
  const open = (r: { company: string | null; job: string | null }) => r.company && r.job && navigate({ site: { company: r.company, job: r.job } })
  const span = f.to - f.from + 1
  const preset = f.to === months.length - 1 ? PRESETS.find((p) => Math.min(p, months.length) === span) : undefined
  const tags: [string, Partial<Filters>][] = []
  if (f.delivery !== 'all') tags.push([DELIVERY_LABEL[f.delivery], { delivery: 'all' }])
  if (f.opco !== 'all') tags.push([OPCO_LABEL[f.opco], { opco: 'all' }])
  if (f.region !== 'all') tags.push([f.region, { region: 'all' }])
  if (f.trades.length < trades.length) tags.push([f.trades.join(', '), { trades: [...TRADES] }])
  if (f.minStars > 1 || f.maxStars < 5) tags.push([f.minStars === f.maxStars ? `${f.minStars} star${f.minStars > 1 ? 's' : ''}` : `${f.minStars} to ${f.maxStars} stars`, { minStars: 1, maxStars: 5 }])
  if (f.comments) tags.push(['With comments', { comments: false }])
  if (theme) tags.push([theme.theme, { theme: null }])
  if (f.q) tags.push([`"${f.q}"`, { q: '' }])
  const reset = Object.assign({}, ...tags.map(([, p]) => p)) as Partial<Filters>
  const toggleTrade = (t: Trade) => set({ trades: f.trades.includes(t) ? (f.trades.length > 1 ? f.trades.filter((x) => x !== t) : f.trades) : [...f.trades, t] })
  const pickStars = (s: number) => set(f.minStars === s && f.maxStars === s ? { minStars: 1, maxStars: 5 } : { minStars: s, maxStars: s })
  const siteCount = new Set(v.rows.map((r) => r.key)).size

  return <div className="fx">
    <section className="fx-bar" aria-label="Feedback filters">
      <div className="fx-bar__row">
        <div className="fx-fg"><span className="fx-lbl" id="fx-period">Period</span>
          <Seg label="Period" value={preset ? String(preset) : ''} options={PRESETS.filter((p) => p <= months.length || p === PRESETS.find((x) => x >= months.length)).map((p) => ({ value: String(p), label: `${p} months` }))}
            onChange={(p) => set({ to: months.length - 1, from: Math.max(0, months.length - Number(p)) })} />
          <label className="sr-only" htmlFor="fx-from">From</label>
          <select id="fx-from" value={f.from} onChange={(e) => { const from = Number(e.target.value); set({ from, to: Math.max(from, f.to) }) }}>
            {months.map((m, i) => <option key={m} value={i}>{mShort(m)}</option>)}</select>
          <span className="fx-lbl">to</span>
          <label className="sr-only" htmlFor="fx-to">To</label>
          <select id="fx-to" value={f.to} onChange={(e) => { const to = Number(e.target.value); set({ to, from: Math.min(f.from, to) }) }}>
            {months.map((m, i) => <option key={m} value={i}>{mShort(m)}</option>)}</select>
        </div>
        {hasDelivery && <div className="fx-fg"><span className="fx-lbl">Delivery</span>
          <Seg label="Delivery" value={f.delivery} onChange={(d) => set({ delivery: d })}
            options={[{ value: 'all', label: 'All' }, { value: 'self_perform', label: 'Self-perform' }, { value: 'subcontracted', label: 'Subcontracted' }]} /></div>}
        {hasOpco && <div className="fx-fg"><span className="fx-lbl">OpCo</span>
          <Seg label="Operating company" value={f.opco} onChange={(o) => set({ opco: o })}
            options={[{ value: 'all', label: 'All' }, { value: 'FXG', label: 'Ground' }, { value: 'FXE', label: 'Express' }]} /></div>}
      </div>
      <div className="fx-bar__row">
        {regions.length > 1 && <div className="fx-fg"><label className="fx-lbl" htmlFor="fx-region">Region</label>
          <select id="fx-region" value={f.region} onChange={(e) => set({ region: e.target.value })}>
            <option value="all">All regions</option>{regions.map((r) => <option key={r} value={r}>{r}</option>)}</select></div>}
        {trades.length > 1 && <div className="fx-fg"><span className="fx-lbl">Trade</span>
          <div className="fx-seg" role="group" aria-label="Trades">{trades.map((t) => <button key={t} type="button" aria-pressed={f.trades.includes(t)} onClick={() => toggleTrade(t)}>{t}</button>)}</div></div>}
        <div className="fx-fg"><label className="fx-lbl" htmlFor="fx-s0">Stars</label>
          <select id="fx-s0" value={f.minStars} onChange={(e) => { const s = Number(e.target.value); set({ minStars: s, maxStars: Math.max(s, f.maxStars) }) }}>
            {[1, 2, 3, 4, 5].map((s) => <option key={s} value={s}>{s}</option>)}</select>
          <label className="fx-lbl" htmlFor="fx-s1">to</label>
          <select id="fx-s1" value={f.maxStars} onChange={(e) => { const s = Number(e.target.value); set({ maxStars: s, minStars: Math.min(s, f.minStars) }) }}>
            {[1, 2, 3, 4, 5].map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
        <label className="check"><input type="checkbox" checked={f.comments} onChange={(e) => set({ comments: e.target.checked })} />With comments</label>
        <div className="fx-fg fx-grow"><label className="sr-only" htmlFor="fx-q">Search sites</label>
          <input id="fx-q" type="search" placeholder="Site, location or job" value={f.q} onChange={(e) => set({ q: e.target.value.trim() })} /></div>
      </div>
      <div className="fx-sum">
        <span><b>{fmt(v.rows.length)}</b> ratings, <b>{fmt(siteCount)}</b> sites, {monthSpan(months[f.from], months[f.to])}</span>
        {tags.length > 0 && <span className="fx-tags">{tags.map(([label, patch]) => <span key={label} className="fx-tag">{label}
          <button type="button" aria-label={`Remove ${label}`} onClick={() => set(patch)}><X size={10} aria-hidden="true" /></button></span>)}
          <button type="button" className="linkbtn" onClick={() => set(reset)}>Reset</button></span>}
      </div>
    </section>

    {!v.rows.length ? <div className="card"><Empty>No ratings match these filters.</Empty></div> : <>
      <Kpis rows={v.rows} prior={v.prior} span={span} periodTickets={v.periodTix} openTickets={v.tix.filter((t) => t.open)} hasTickets={!!tickets?.tickets.length} />
      <div className="fx-grid fx-2-1">
        <section className="card"><div className="ct"><span>Share of 1-3 star ratings and avg by month</span>
          <span className="legend fx-legend"><span><i style={{ background: 'var(--warn)' }} />3 stars</span><span><i style={{ background: 'var(--bad)' }} />1-2 stars</span><span><i className="solid" />Avg rating</span></span></div>
          <Trend rows={v.scoped.filter((r) => !f.comments || r.comment)} months={months} f={f} /></section>
        <section className="card"><div className="ct"><span>Score distribution</span><span className="ks">{fmt(v.rows.length)} ratings</span></div>
          <Distribution rows={v.unstarred.filter((r) => inMonths(r.month, months, f.from, f.to) && (!f.comments || r.comment))} f={f} onPick={pickStars} /></section>
      </div>
      <div className="fx-grid fx-5-7">
        <Sentiment overview={overview} ratings={v.unstarred} since={recent.since} last={recent.last} themes={themes} selected={f.theme}
          onTheme={(i) => set({ theme: f.theme === i ? null : i })} onSite={(q) => set({ q })} />
        <Comments rows={theme ? v.rows.filter((r) => r.date > recent.since && theme.locations.some((l) => normLoc(l) === normLoc(r.loc))) : v.rows} theme={theme} onOpen={open} />
      </div>
      <Movers current={v.rows} prior={v.prior} months={months} range={v.pr} now={{ from: f.from, to: f.to }} onOpen={open} onSite={(q) => set({ q })} />
      {!!tickets?.tickets.length && <Tickets rows={v.rows} scoped={v.unstarred} tickets={v.periodTix} all={v.tix} months={months} f={f} meta={tickets} account={account} onOpen={open} />}
      <Watchlist rows={v.rows} tickets={v.periodTix} months={months.slice(Math.max(f.from, f.to - 5), f.to + 1)} account={account} onOpen={open} hasTickets={!!tickets?.tickets.length} />
    </>}
  </div>
}

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T | ''; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return <div className="fx-seg" role="group" aria-label={label}>
    {options.map((o) => <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}
  </div>
}

function Kpis({ rows, prior, span, periodTickets, openTickets, hasTickets }: { rows: Rating[]; prior: Rating[] | null; span: number
  periodTickets: Ticket[]; openTickets: Ticket[]; hasTickets: boolean }) {
  const s = summarize(rows), p = prior?.length ? summarize(prior) : null
  const vs = `vs prior ${span === 1 ? 'month' : `${span} months`}`
  const d = s.average != null && p?.average != null ? s.average - p.average : null
  const dl = s.lowRate != null && p?.lowRate != null ? s.lowRate - p.lowRate : null
  return <div className="fx-kpis">
    <div className="kpi fx-kpi-lg"><div className="kl">Avg rating</div>
      <div className={`kv ${avgTone(s.average)}`}>{avg2(s.average)}<span className="of"> / 5</span></div>
      <div className="ks">{d == null ? 'No prior period' : <><span className={`fx-delta ${d >= 0 ? 'ok' : 'bad'}`}>{signed(d)}</span> {vs}, was {avg2(p!.average)}</>}</div></div>
    <div className="kpi fx-kpi-lg"><div className="kl">1-2 star rate</div>
      <div className={`kv ${s.low ? 'bad' : 'ok'}`}>{pct0(s.lowRate)}</div>
      <div className="ks">{fmt(s.low)} ratings{dl == null ? '' : <>, <span className={`fx-delta ${dl <= 0 ? 'ok' : 'bad'}`}>{signed(dl * 100, 1)} pts</span> {vs}</>}</div></div>
    <div className="fx-kpis__sm">
      <Kpi small label="Ratings" value={fmt(s.ratings)} sub={`${fmt(s.visits)} visits`} />
      <Kpi small label="5-star share" value={pct0(s.ratings ? s.five / s.ratings : null)} sub={`${fmt(s.five)} ratings`} />
      <Kpi small label="Sites below 3.5" value={s.sitesBelow} tone={s.sitesBelow ? 'warn' : 'ok'} sub={`of ${s.sites} rated`} />
      {hasTickets
        ? <Kpi small label="Service tickets" value={fmt(new Set(periodTickets.map((t) => t.ticket_number)).size)} tone="" sub={`received; ${new Set(openTickets.map((t) => t.ticket_number)).size} open now`} />
        : <Kpi small label="Comment rate" value={pct0(s.ratings ? rows.filter((r) => r.comment).length / s.ratings : null)} />}
    </div>
  </div>
}

function Trend({ rows, months, f }: { rows: Rating[]; months: string[]; f: Filters }) {
  const m = monthly(rows.filter((r) => inMonths(r.month, months, f.from, f.to)), months.slice(f.from, f.to + 1))
  return <div className="fx-chart" style={{ height: 260 }}>
    <RatingShareChart labels={m.map((x) => mShort(x.month))} low={m.map((x) => x.low)} three={m.map((x) => x.three)} average={m.map((x) => x.average)} ratings={m.map((x) => x.ratings)} />
  </div>
}

function Distribution({ rows, f, onPick }: { rows: Rating[]; f: Filters; onPick: (s: number) => void }) {
  const by = distribution(rows), n = rows.length || 1, max = Math.max(1, ...by.map((b) => b.count))
  const shown = rows.filter((r) => r.score >= f.minStars && r.score <= f.maxStars)
  const sorted = shown.map((r) => r.score).sort((a, b) => a - b)
  return <>
    <div className="fx-dist" role="group" aria-label="Filter by stars">{by.map((b) => <button key={b.stars} type="button" aria-pressed={b.stars >= f.minStars && b.stars <= f.maxStars} onClick={() => onPick(b.stars)}>
      <span className="s">{b.stars} star{b.stars > 1 ? 's' : ''}</span>
      <span className="bt"><span className={`bar ${starTone(b.stars)}`} style={{ width: `${(b.count / max) * 100}%` }} /></span>
      <span className="n"><b>{fmt(b.count)}</b> {pct0(b.count / n)}</span></button>)}</div>
    <div className="fx-distfoot">
      <div>Median<b>{sorted.length ? sorted[Math.floor(sorted.length / 2)] : '–'}</b></div>
      <div>4-5 stars<b>{pct0((by[0].count + by[1].count) / n)}</b></div>
      <div>Comment rate<b>{pct0(rows.filter((r) => r.comment).length / n)}</b></div>
    </div>
  </>
}

function Sentiment({ overview, ratings, since, last, themes, selected, onTheme, onSite }: { overview: Overview | undefined; ratings: Rating[]; since: string; last: string
  themes: Theme[]; selected: number | null; onTheme: (i: number) => void; onSite: (q: string) => void }) {
  const s = overview?.summary
  const win = ratings.filter((r) => r.date > since)
  const visits = commentVisits(win)
  const pos = visits.filter((c) => c.min >= 4).length, mid = visits.filter((c) => c.min === 3).length, neg = visits.filter((c) => c.min <= 2).length, n = visits.length || 1
  const critical = [...groupBy(win, (r) => r.key).values()].map((g) => ({ site: g[0].site, avg: mean(g.map((r) => r.score))!, n: g.length }))
    .filter((x) => x.avg < 3).sort((a, b) => a.avg - b.avg).slice(0, 4)
  const mood = s?.status === 'ready' && s.summary ? s.summary : null
  const days = s?.window_days ?? 90
  return <section className="card"><div className="ct"><span>Customer sentiment, {days} days</span>
    {mood ? <span className={`badge b${SENT_TONE[mood.sentiment]}`}>{mood.sentiment[0].toUpperCase() + mood.sentiment.slice(1)}</span>
      : <span className="badge bnone">{s?.status === 'pending' ? 'Updating' : 'Summary unavailable'}</span>}</div>
    {mood && <><p className="fx-sent__line">{mood.headline}</p>
      <div className="ks">{fmt(s!.comments ?? 0)} comments to {last ? dLabel(last) : '–'}</div></>}
    <div className="fx-mix" aria-hidden="true"><span className="ok" style={{ width: `${(pos / n) * 100}%` }} /><span className="warn" style={{ width: `${(mid / n) * 100}%` }} /><span className="bad" style={{ width: `${(neg / n) * 100}%` }} /></div>
    <div className="fx-mixlbl"><span>{pos} visits at 4-5 stars</span><span>{mid} at 3</span><span>{neg} at 1-2</span></div>
    {themes.length > 0 && <div className="fx-themes" role="group" aria-label="Filter comments by theme">{themes.map((t, i) =>
      <button key={t.theme} type="button" className="fx-theme" aria-pressed={selected === i} onClick={() => onTheme(i)}>
        <span className={`dot ${SENT_TONE[t.sentiment]}`} /><span>{t.theme}</span>
        <span className="m">{t.mentions} comments, {new Set(t.locations).size} sites</span></button>)}</div>}
    {critical.length > 0 && <div className="fx-crit"><div className="kl">Lowest rated, {days} days</div>
      <div className="chips">{critical.map((c) => <button key={c.site} type="button" className="chip linkbtn" onClick={() => onSite(c.site)}>{c.site}: {c.avg.toFixed(2)}</button>)}</div></div>}
  </section>
}

function Comments({ rows, theme, onOpen }: { rows: Rating[]; theme: Theme | null; onOpen: (r: { company: string | null; job: string | null }) => void }) {
  const visits = commentVisits(rows)
  const [shown, setShown] = useState(40)
  return <section className="card"><div className="ct"><span>Comments{theme ? `, ${theme.theme}` : ''}</span><span className="ks">{fmt(visits.length)} visits with comments</span></div>
    {visits.length ? <div className="fx-stream">{visits.slice(0, shown).map((c) => <article key={`${c.loc}|${c.date}`} className="fx-cm">
      <span className={`sc ${starTone(c.min)}`}>{c.min}</span>
      <p>{c.comments.join(' / ')}</p>
      <div className="meta"><span>{dLabel(c.date)}</span>
        {c.job ? <button type="button" className="linkbtn" onClick={() => onOpen(c)}>{c.site}</button> : <span>{c.site}</span>}
        <span>{c.scores.map((x) => `${x.trade} ${x.score}`).join(', ')}</span><span>{DELIVERY_LABEL[c.delivery]}</span></div>
    </article>)}
      {visits.length > shown && <button type="button" className="linkbtn fx-more" onClick={() => setShown((x) => x + 40)}>Show {Math.min(40, visits.length - shown)} more</button>}</div>
      : <Empty>No comments match these filters.</Empty>}
  </section>
}

function Movers({ current, prior, months, range, now, onOpen, onSite }: { current: Rating[]; prior: Rating[] | null; months: string[]; range: { from: number; to: number } | null
  now: { from: number; to: number }; onOpen: (r: { company: string | null; job: string | null }) => void; onSite: (q: string) => void }) {
  const cur = monthSpan(months[now.from], months[now.to])
  const was = range ? monthSpan(months[range.from], months[range.to]) : ''
  const m = prior ? movers(current, prior) : null
  const list = (xs: Mover[] | undefined, empty: string): ReactNode => (!m ? <Empty>No prior period for this range.</Empty> : xs!.length
    ? <div className="fx-mv"><div className="fx-mv__h" aria-hidden="true"><span>Site</span><span>Prior avg</span><span>Current avg</span><span>Change</span></div>
      {xs!.map((r) => <button key={r.key} type="button" className="fx-mv__r" onClick={() => (r.job ? onOpen(r) : onSite(r.site))}
        aria-label={`${r.site}: ${r.was.toFixed(2)} prior, ${r.now.toFixed(2)} current, ${signed(r.change)}`}>
      <span className="fx-mv__nm">{r.site}<small>{r.region}, {DELIVERY_LABEL[r.delivery]}</small></span>
      <span className="fx-mv__v meta">{r.was.toFixed(2)}<small>{r.priorRatings} ratings</small></span>
      <span className="fx-mv__v"><b className={avgTone(r.now)}>{r.now.toFixed(2)}</b><small>{r.ratings} ratings</small></span>
      <span className={`fx-mv__d ${r.change < 0 ? 'bad' : 'ok'}`}>{signed(r.change)}</span>
      {r.comment && <span className="fx-mv__c"><span className="meta">Latest comment{r.commentDate ? `, ${dLabel(r.commentDate)}` : ''}: </span>{r.comment}</span>}</button>)}</div>
    : <Empty>{empty}</Empty>)
  const head = (t: string) => <div className="ct"><span>{t}</span><span className="ks">{was ? `${cur} vs ${was}` : cur}</span></div>
  return <div className="fx-grid fx-1-1">
    <section className="card">{head('Declined most')}{list(m?.down, 'No site fell by 0.1 or more.')}</section>
    <section className="card">{head('Improved most')}{list(m?.up, 'No site rose by 0.1 or more.')}</section>
  </div>
}

function Tickets({ rows, scoped, tickets, all, months, f, meta, account, onOpen }: { rows: Rating[]; scoped: Rating[]; tickets: Ticket[]; all: Ticket[]; months: string[]; f: Filters
  meta: ServiceTicketsResponse; account: LeadershipAccount; onOpen: (r: { company: string | null; job: string | null }) => void }) {
  const today = new Date().toISOString().slice(0, 10)
  const openList = all.filter((t) => t.open).sort((a, b) => (a.date_received ?? '9').localeCompare(b.date_received ?? '9'))
  const st = ticketStats(rows, scoped, tickets)
  const unique = new Set(tickets.map((t) => t.ticket_number)).size
  const types = [...groupBy(tickets, (t) => issueGroup(t.issue_type))].map(([k, g]) => [k, new Set(g.map((t) => t.ticket_number)).size] as const).sort((a, b) => b[1] - a[1])
  const span = months.slice(f.from, f.to + 1)
  const tBy = groupBy(tickets, (t) => t.month ?? '')
  const rBy = groupBy(rows, (r) => r.month)
  const level = (t: ServiceTicket) => (t.escalation_level ? <span className={`badge ${/2|3|termination/i.test(t.escalation_level) ? 'bbad' : 'bwarn'}`}>{t.escalation_level}</span> : null)
  const cols: Column<Ticket>[] = [
    { key: 'ticket', header: 'Ticket', left: true, value: (r) => r.ticket_number },
    { key: 'site', header: 'Site', left: true, value: (r) => r.site, className: 'nm' },
    { key: 'status', header: 'Status', left: true, value: (r) => (r.open ? `0 ${r.status}` : `1 ${r.status}`), render: (r) => <span className={r.open ? 'bad' : 'neutral'}>{r.status ?? '–'}</span>, csv: (r) => r.status },
    { key: 'issue', header: 'Issue', left: true, value: (r) => r.issue_type ?? '' },
    { key: 'level', header: 'Escalation', left: true, value: (r) => r.escalation_level ?? '' },
    { key: 'received', header: 'Received', left: true, value: (r) => r.date_received ?? '' },
    { key: 'days', header: 'Days open', value: (r) => r.days_open },
    { key: 'closed', header: 'Closed', left: true, value: (r) => r.date_closed ?? '' },
    { key: 'owner', header: 'Assigned', left: true, value: (r) => r.assigned_to ?? '' },
    { key: 'note', header: 'Latest note', left: true, value: (r) => r.latest_note ?? '', render: (r) => <span title={r.latest_note ?? undefined}>{r.latest_note ?? ''}</span>, className: 'wrap fx-clamp', csv: (r) => r.notes },
  ]
  return <>
    <div className="fx-grid fx-1-1">
      <section className="card"><div className="ct"><span>Open tickets</span><span className="ks">{new Set(openList.map((t) => t.ticket_number)).size} open now</span></div>
        {openList.length ? <div className="fx-tk">{openList.map((t) => {
          const late = !!t.expected_close && t.expected_close < today
          return <button key={`${t.ticket_number}|${t.loc}`} type="button" className="fx-tk__r" disabled={!t.job} onClick={() => onOpen(t)}>
            <span className="fx-tk__nm">{t.site}<small>{t.ticket_number}{t.issue_type ? `, ${t.issue_type}` : ''}{t.assigned_to ? `, ${t.assigned_to}` : ''}</small></span>
            <span className="fx-tk__m">{level(t)}<span className={t.days_open == null ? '' : t.days_open > 60 ? 'bad' : t.days_open > 30 ? 'warn' : ''}><b>{t.days_open ?? '–'}</b> days open</span>
              <span className={`meta ${late ? 'bad' : ''}`}>{t.expected_close ? `Due ${dLabel(t.expected_close)}` : 'No due date'}</span></span>
            {t.latest_note && <span className="fx-tk__c">{t.latest_note}</span>}
          </button>
        })}</div> : <Empty>No open tickets.</Empty>}
      </section>
      <section className="card"><div className="ct"><span>Tickets and star ratings</span><span className="ks">{fmt(unique)} tickets received in period</span></div>
        <div className="fx-corr">
          <div>Avg, sites with a ticket<b className={avgTone(st.withTicket.average)}>{avg2(st.withTicket.average)}</b><span className="meta">{st.withTicket.sites} sites</span></div>
          <div>Avg, sites without<b className={avgTone(st.without.average)}>{avg2(st.without.average)}</b><span className="meta">{st.without.sites} sites</span></div>
          <div>90 days before a ticket<b className={avgTone(st.before.average)}>{avg2(st.before.average)}</b><span className="meta">{st.before.tickets} tickets</span></div>
          <div>90 days after close<b className={avgTone(st.after.average)}>{avg2(st.after.average)}</b><span className="meta">{st.after.tickets} tickets</span></div>
          <div>Median days to close<b>{st.daysToClose ?? '–'}</b><span className="meta">{st.closed} closed</span></div>
          {meta.lift != null && <div title={`Location-months averaging under 3.0 over the prior ${meta.lookback_days} days against those at 4.5 and up, ticket within ${meta.horizon_days} days`}>
            Ticket rate, under 3.0 vs 4.5 up<b>{meta.lift.toFixed(1)}x</b><span className="meta">{fmt(meta.observations)} location-months</span></div>}
        </div>
        <div className="ct fx-sub"><span>Tickets received and avg rating by month</span>
          <span className="legend fx-legend"><span><i style={{ background: 'var(--accent2)' }} />Tickets</span><span><i className="solid" />Avg rating</span></span></div>
        <div className="fx-chart" style={{ height: 170 }}>
          <TicketMonthChart labels={span.map(mShort)} tickets={span.map((m) => new Set((tBy.get(m) ?? []).map((t) => t.ticket_number)).size)}
            average={span.map((m) => mean((rBy.get(m) ?? []).map((r) => r.score)))} /></div>
        {types.length > 0 && <div className="fx-tt">{types.map(([k, n]) => <span key={k}><b>{n}</b> {k}</span>)}</div>}
      </section>
    </div>
    <section className="card fx-card"><div className="ct"><span>Service tickets</span><span className="ks">{meta.unmatched ? `${meta.unmatched} with no WinTeam job` : `${fmt(all.length)} tickets`}</span></div>
      <SortTable caption="Service tickets" rows={all} columns={cols} defaultSort={{ key: 'status', dir: 1 }} pageSize={10}
        onRowClick={(r) => onOpen(r)} rowLabel={(r) => `Open ${r.site}`} csvName={`${account.slug}-service-tickets`} /></section>
  </>
}

function Watchlist({ rows, tickets, months, account, onOpen, hasTickets }: { rows: Rating[]; tickets: Ticket[]; months: string[]; account: LeadershipAccount
  onOpen: (r: { company: string | null; job: string | null }) => void; hasTickets: boolean }) {
  const data = siteRows(rows, tickets)
  const cols: Column<SiteRow>[] = [
    { key: 'site', header: 'Site', left: true, value: (r) => r.site, className: 'nm' },
    { key: 'region', header: 'Region', left: true, value: (r) => r.region },
    { key: 'delivery', header: 'Delivery', left: true, value: (r) => DELIVERY_LABEL[r.delivery] },
    { key: 'n', header: 'Ratings', value: (r) => r.ratings },
    { key: 'avg', header: 'Avg', value: (r) => r.average, render: (r) => <span className={avgTone(r.average)}>{r.average.toFixed(2)}</span> },
    { key: 'adj', header: 'Adjusted', value: (r) => r.adjusted, render: (r) => <b className={avgTone(r.adjusted)}>{r.adjusted.toFixed(2)}</b> },
    { key: 'low', header: '1-2 stars', value: (r) => r.low, render: (r) => <span className={r.low ? 'bad' : ''}>{r.low}</span> },
    ...(hasTickets ? [{ key: 'tickets', header: 'Tickets', value: (r: SiteRow) => r.tickets }] : []),
    ...months.map((m): Column<SiteRow> => ({ key: `m${m}`, header: monthShort(`${m}-01`), value: (r) => r.months[m] ?? null, className: 'fx-heat',
      render: (r) => { const x = r.months[m]; return <span className={x == null ? 'h-none' : `h-${avgTone(x)}`}>{x == null ? '–' : x.toFixed(1)}</span> } })),
    { key: 'latest', header: 'Latest comment', left: true, value: (r) => r.latestDate, render: (r) => <span title={r.latest ?? undefined}>{r.latest ?? ''}</span>,
      csv: (r) => r.latest, className: 'wrap fx-clamp' },
  ]
  return <section className="card fx-card"><div className="ct"><span>Site watchlist</span>
    <span className="ks" title="The site's average pulled toward the filtered average by 5 ratings">Adjusted avg, lowest first</span></div>
    <SortTable caption="Site watchlist" rows={data} columns={cols} defaultSort={{ key: 'adj', dir: 1 }} pageSize={25}
      onRowClick={onOpen} rowLabel={(r) => `Open ${r.site}`} csvName={`${account.slug}-site-watchlist`} /></section>
}

/** Fetches the feedback, the service tickets and the overview (for the sentiment summary). */
export function useServiceTickets(account: LeadershipAccount) {
  const { api, keyPrefix, decision } = useLeadership()
  return useApiQuery<ServiceTicketsResponse>(decision ? queryKey(`${keyPrefix}/leadership/service-tickets`, { account: account.slug }) : null,
    (signal) => api.serviceTickets(account.slug, signal), [api, account.slug])
}
