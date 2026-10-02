import { useApiQuery } from '../../hooks/useApiQuery'
import type { LeadershipAccount, LeadershipFeedbackResponse } from '../../services/apiTypes'
import { queryKey } from '../../services/queryClient'
import { monthLabel } from '../routes'
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
