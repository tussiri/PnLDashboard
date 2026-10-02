import { useEffect } from 'react'
import { useApiQuery } from '../../hooks/useApiQuery'
import type { FeedbackOverview, FeedbackSentiment, LeadershipAccount, LeadershipFeedbackResponse } from '../../services/apiTypes'
import { queryKey } from '../../services/queryClient'
import { formatRoute, monthLabel } from '../routes'
import { useLeadership } from '../state'
import { Empty, Kpi, LoadError, Skeleton, SortTable, type Column } from '../ui'

type Line = LeadershipFeedbackResponse['lines'][number]
type Site = LeadershipFeedbackResponse['by_site'][number]

export const stars = (score: number | null) => (score == null ? '–' : score.toFixed(score % 1 ? 1 : 0))
export const scoreTone = (score: number | null) => (score == null ? '' : score <= 2 ? 'bad' : score < 4 ? 'warn' : 'ok')
const MONTHS = 12

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
    { key: 'comment', header: 'Latest comment', left: true, value: (r) => r.latest_comment ?? '', className: 'nm' },
  ]
  const lineCols: Column<Line>[] = [
    { key: 'date', header: 'Date', left: true, value: (r) => r.feedback_date },
    { key: 'site', header: 'Site', left: true, value: siteName, className: 'nm' },
    { key: 'loc', header: 'Location', left: true, value: (r) => r.location_number },
    { key: 'trade', header: 'Trade', left: true, value: (r) => r.trade ?? '' },
    { key: 'fb', header: 'Feedback', left: true, value: (r) => r.feedback ?? '' },
    { key: 'score', header: 'Rating', value: (r) => r.score, render: (r) => <span className={scoreTone(r.score)}>{stars(r.score)}</span> },
    { key: 'comment', header: 'Comment', left: true, value: (r) => r.comment ?? '', className: 'nm' },
    { key: 'wo', header: 'WO', left: true, value: (r) => r.wo_number },
  ]
  return <>
    <div className="kpi-lg">
      <Kpi label="Avg rating" value={<>{stars(d.average)}<span className="of"> / 5</span></>} tone={scoreTone(d.average)} sub={`Since ${monthLabel(d.since)}`} />
      <Kpi label="Ratings" value={d.ratings.toLocaleString('en-US')} sub={`${d.sites} sites`} />
      <Kpi label="1-2 stars" value={d.low.toLocaleString('en-US')} tone={d.low ? 'bad' : 'ok'} sub={d.ratings ? `${Math.round((d.low / d.ratings) * 100)}% of ratings` : undefined} />
      <Kpi label="Unmatched locations" value={d.unmatched.toLocaleString('en-US')} tone={d.unmatched ? 'warn' : ''} sub="No WinTeam job" />
    </div>
    <div className="card"><div className="ct"><span>By site</span></div>
      <SortTable caption="Feedback by site" rows={d.by_site} columns={siteCols} defaultSort={{ key: 'avg', dir: 1 }} pageSize={25}
        onRowClick={open} rowLabel={(r) => `Open ${siteName(r)}`} csvName={`${account.slug}-feedback-by-site`} /></div>
    <div className="card"><div className="ct"><span>Ratings</span></div>
      <SortTable caption="Feedback and star ratings" rows={d.lines} columns={lineCols} defaultSort={{ key: 'date', dir: -1 }} pageSize={50}
        onRowClick={open} rowLabel={(r) => `Open ${siteName(r)}`} csvName={`${account.slug}-feedback`} /></div>
  </>
}

const SENTIMENT: Record<FeedbackSentiment, { label: string; tone: string }> = {
  positive: { label: 'Positive', tone: 'ok' }, mixed: { label: 'Mixed', tone: 'warn' }, negative: { label: 'Negative', tone: 'bad' } }
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`

/** Home: the account's customer feedback at a glance. Scores for the month to date, the prior month and 12 months
 * (computed from the ratings), and Claude's summary of the last 90 days of comments, labeled as such. */
export function FeedbackTile({ account, month }: { account: LeadershipAccount; month: string | undefined }) {
  const { api, keyPrefix, decision, navigate } = useLeadership()
  const q = useApiQuery<FeedbackOverview>(decision ? queryKey(`${keyPrefix}/leadership/feedback/overview`, { account: account.slug, month }) : null,
    (signal) => api.leadershipFeedbackOverview(account.slug, month, signal), [api, account.slug, month])
  const pending = q.data?.summary.status === 'pending'
  useEffect(() => {
    if (!pending) return
    const t = window.setTimeout(() => q.refetch(), 15_000)
    return () => window.clearTimeout(t)
  }, [pending, q])
  const d = q.data
  if (q.error || !d || !d.year.ratings) return null
  const cur = d.current
  const change = cur?.average != null && d.prior?.average != null ? cur.average - d.prior.average : null
  const s = d.summary
  const lows = [...new Map(d.low_sites.map((l) => [l.location_number, l])).values()]
  const href = formatRoute({ view: 'account', account: account.slug, tab: 'feedback' })
  return <section className="card fbt" aria-label={`${account.name} customer feedback`}>
    <div className="ct"><span>Customer feedback</span><a className="ks" href={href}>All feedback</a></div>
    <div className="kpi4">
      <Kpi label={`Avg rating, ${monthLabel(d.month)} MTD`} value={cur?.average != null ? <>{stars(cur.average)}<span className="of"> / 5</span></> : '–'}
        tone={scoreTone(cur?.average ?? null)} sub={cur ? `${cur.ratings} ratings${change != null ? `; ${signed(change)} vs prior month` : ''}` : 'No ratings yet'} />
      <Kpi label="Prior month" value={d.prior?.average != null ? stars(d.prior.average) : '–'} tone={scoreTone(d.prior?.average ?? null)}
        sub={d.prior ? `${d.prior.ratings} ratings` : undefined} />
      <Kpi label="12-month avg" value={stars(d.year.average)} tone={scoreTone(d.year.average)} sub={`${d.year.ratings.toLocaleString('en-US')} ratings`} />
      <Kpi label="1-2 stars MTD" value={cur?.low ?? 0} tone={cur?.low ? 'bad' : 'ok'}
        sub={lows.length ? lows.slice(0, 4).map((l) => l.location_number).join(', ') + (lows.length > 4 ? `, ${lows.length - 4} more` : '') : undefined} />
    </div>
    {s.status === 'ready' && s.summary && <div className="fbt__ai">
      <div className="fbt__hd"><span className="kl">AI summary, {s.window_days} days of comments</span>
        <span className={`badge ${{ ok: 'bok', warn: 'bwarn', bad: 'bbad' }[SENTIMENT[s.summary.sentiment].tone]}`}>{SENTIMENT[s.summary.sentiment].label}</span>
        <span className="ks">{s.comments} comments</span></div>
      <p className="fbt__line">{s.summary.headline}</p>
      {s.summary.themes.length > 0 && <div className="chips">{s.summary.themes.map((t) => <span key={t.theme} className={`chip ${SENTIMENT[t.sentiment].tone}`}
        title={t.locations.join(', ')}>{t.theme} ({t.mentions})</span>)}</div>}
    </div>}
    {s.status === 'pending' && <div className="fbt__ai"><span className="kl">AI summary updating</span></div>}
    {lows.length > 0 && <div className="chips">{lows.slice(0, 8).map((l) => <button key={l.location_number} type="button" className="chip linkbtn"
      onClick={() => l.company && l.job_number && navigate({ site: { company: l.company, job: l.job_number } })}>{l.site_name ?? l.location_number}: {stars(l.score)}</button>)}</div>}
  </section>
}