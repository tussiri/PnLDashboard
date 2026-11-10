import { useMemo, useState } from 'react'
import type { FeedbackSliceAnalysis, FeedbackSentiment, LeadershipAccount } from '../../services/apiTypes'
import { RatingLinesChart, seriesColor, useTokens } from '../charts'
import { DIMENSIONS, DIMENSION_LABEL, EMPTY_FILTERS, SCORE_BANDS, filterLines, groupRows, options, rollingSeries, stats, valueOf, type Dimension, type Filters, type GroupRow, type Line, type ScoreBand } from '../feedbackExplorer'
import { pct } from '../format'
import { useLeadership } from '../state'
import { ChartCard, Kpi, SortTable, type Column } from '../ui'
import { scoreTone, stars } from './Feedback'

const PERIODS: { value: string; label: string; days: number | null }[] = [
  { value: '30', label: '30 days', days: 30 }, { value: '90', label: '90 days', days: 90 }, { value: '180', label: '6 months', days: 180 },
  { value: '365', label: '12 months', days: 365 }, { value: 'all', label: 'All loaded', days: null }]
const SERIES_MAX = 6
const SENTIMENT_TONE: Record<FeedbackSentiment, string> = { positive: 'ok', mixed: 'warn', negative: 'bad' }
const avg = (v: number | null) => (v == null ? '–' : v.toFixed(2))

/** Slice and dice the star ratings: filters on every dimension, a group-by, a running-average window, and Claude's
 * reading of the comments in the slice on demand. */
export function FeedbackExplorer({ account, lines }: { account: LeadershipAccount; lines: Line[] }) {
  const { api, navigate } = useLeadership()
  const t = useTokens()
  const [filters, setFilters] = useState<Filters>({ ...EMPTY_FILTERS, days: 365 })
  const [groupBy, setGroupBy] = useState<Dimension>('region')
  const [window, setWindow] = useState(30)
  const [analysis, setAnalysis] = useState<{ key: string; state: 'running' | 'done'; result?: FeedbackSliceAnalysis; error?: string } | null>(null)

  // A dimension is offered only when the loaded ratings take more than one value on it.
  const dims = useMemo(() => DIMENSIONS.filter((d) => options(lines, d).length > 1), [lines])
  const slice = useMemo(() => filterLines(lines, filters), [lines, filters])
  const total = useMemo(() => stats(slice), [slice])
  const groups = useMemo(() => groupRows(slice, groupBy, window), [slice, groupBy, window])
  const chart = useMemo(() => {
    const top = [...groups].sort((a, b) => b.ratings - a.ratings).slice(0, SERIES_MAX - 1)
    return rollingSeries([{ label: 'Slice', lines: slice }, ...top.map((g) => ({ label: g.key, lines: slice.filter((l) => valueOf(l, groupBy) === g.key) }))], window)
  }, [groups, slice, groupBy, window])
  const sliceKey = useMemo(() => slice.map((l) => l.wo_number).sort().join(','), [slice])
  const setValue = (d: Dimension, v: string) => setFilters((f) => ({ ...f, values: { ...f.values, [d]: v || undefined } }))

  const analyze = async () => {
    setAnalysis({ key: sliceKey, state: 'running' })
    try {
      const result = await api.analyzeFeedback(account.slug, slice.map((l) => l.wo_number))
      setAnalysis({ key: sliceKey, state: 'done', result })
    } catch (e) {
      setAnalysis({ key: sliceKey, state: 'done', error: e instanceof Error ? e.message : String(e) })
    }
  }
  const current = analysis && analysis.key === sliceKey ? analysis : null

  const cols: Column<GroupRow>[] = [
    { key: 'key', header: DIMENSION_LABEL[groupBy], left: true, value: (r) => r.key, className: 'nm' },
    { key: 'ratings', header: 'Ratings', value: (r) => r.scored },
    { key: 'avg', header: 'Avg rating', value: (r) => r.average, render: (r) => <span className={scoreTone(r.average)}>{avg(r.average)}</span> },
    { key: 'recent', header: `Last ${window} days`, value: (r) => r.recent, render: (r) => <span className={scoreTone(r.recent)}>{avg(r.recent)}<span className="neutral"> ({r.recentN})</span></span>, csv: (r) => r.recent },
    { key: 'change', header: 'Change', value: (r) => r.change, render: (r) => <span className={r.change == null ? '' : r.change < 0 ? 'bad' : r.change > 0 ? 'ok' : ''}>{r.change == null ? '–' : `${r.change >= 0 ? '+' : '−'}${Math.abs(r.change).toFixed(2)}`}</span> },
    { key: 'low', header: '1-2 stars', value: (r) => r.lowShare, render: (r) => <span className={r.low ? 'bad' : ''}>{r.low} <span className="neutral">{pct(r.lowShare)}</span></span>, csv: (r) => r.low },
    { key: 'sites', header: 'Sites', value: (r) => r.sites },
    { key: 'comments', header: 'Comments', value: (r) => r.comments },
    { key: 'latest', header: 'Latest', left: true, value: (r) => r.latest ?? '' },
  ]
  const openGroup = groupBy === 'site' ? (r: GroupRow) => {
    const l = slice.find((x) => valueOf(x, 'site') === r.key)
    if (l?.company && l.job_number) navigate({ site: { company: l.company, job: l.job_number } })
  } : (r: GroupRow) => setValue(groupBy, r.key)

  return <div className="card explorer">
    <div className="ct"><span>Ratings explorer</span><span className="ks">{total.scored.toLocaleString('en-US')} ratings in the slice</span></div>
    <div className="explorer-filters">
      <label className="field"><span>Period</span>
        <select value={PERIODS.find((p) => p.days === filters.days)?.value ?? 'all'} onChange={(e) => setFilters((f) => ({ ...f, days: PERIODS.find((p) => p.value === e.target.value)?.days ?? null }))}>
          {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label>
      {dims.filter((d) => d !== 'month').map((d) => <label key={d} className="field"><span>{DIMENSION_LABEL[d]}</span>
        <select value={filters.values[d] ?? ''} onChange={(e) => setValue(d, e.target.value)}>
          <option value="">All</option>
          {options(filterLines(lines, { ...filters, values: { ...filters.values, [d]: undefined } }), d).map((o) => <option key={o.value} value={o.value}>{o.value} ({o.n})</option>)}
        </select></label>)}
      <label className="field"><span>Score</span>
        <select value={filters.score} onChange={(e) => setFilters((f) => ({ ...f, score: e.target.value as ScoreBand }))}>
          {Object.entries(SCORE_BANDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="field"><span>Search</span>
        <input type="search" value={filters.search} placeholder="Site, location or comment" onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} /></label>
      <label className="field check"><input type="checkbox" checked={filters.comments} onChange={(e) => setFilters((f) => ({ ...f, comments: e.target.checked }))} />With comments</label>
      <button type="button" className="btn sm" onClick={() => setFilters({ ...EMPTY_FILTERS, days: filters.days })}>Clear</button>
    </div>
    <div className="explorer-controls">
      <label className="field"><span>Group by</span>
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as Dimension)}>
          {dims.map((d) => <option key={d} value={d}>{DIMENSION_LABEL[d]}</option>)}</select></label>
      <label className="field explorer-slider"><span>Running average: {window} days</span>
        <input type="range" min={7} max={180} step={1} value={window} aria-label="Running average window in days" onChange={(e) => setWindow(Number(e.target.value))} /></label>
    </div>
    <div className="kpi-lg">
      <Kpi label="Avg rating" value={<>{avg(total.average)}<span className="of"> / 5</span></>} tone={scoreTone(total.average)} sub={`${total.scored.toLocaleString('en-US')} ratings`} />
      <Kpi label="1-2 stars" value={pct(total.lowShare)} tone={total.low ? 'bad' : 'ok'} sub={`${total.low.toLocaleString('en-US')} ratings`} />
      <Kpi label="Sites" value={total.sites.toLocaleString('en-US')} sub={total.latest ? `Latest ${total.latest}` : undefined} />
      <Kpi label="Comments" value={total.comments.toLocaleString('en-US')} sub={total.ratings ? `${pct(total.comments / total.ratings)} of ratings` : undefined} />
    </div>
    {chart.labels.length > 1 && <ChartCard title={`${window}-day running average`} height={260}
      chart={<RatingLinesChart labels={chart.labels} ariaLabel={`${window}-day running average rating by ${DIMENSION_LABEL[groupBy].toLowerCase()}`}
        series={chart.series.map((s, i) => ({ ...s, color: i === 0 ? t.text : seriesColor(t, i - 1) }))} />}
      table={<table><thead><tr><th className="nosort l">Week ending</th>{chart.series.map((s) => <th key={s.label} className="nosort">{s.label}</th>)}</tr></thead>
        <tbody>{chart.labels.map((label, i) => <tr key={label}><td className="l">{label}</td>{chart.series.map((s) => <td key={s.label}>{avg(s.data[i])} <span className="neutral">({s.counts[i]})</span></td>)}</tr>)}</tbody></table>} />}
    <SortTable caption={`Ratings by ${DIMENSION_LABEL[groupBy].toLowerCase()}`} rows={groups} columns={cols} defaultSort={{ key: groupBy === 'month' ? 'key' : 'ratings', dir: -1 }} pageSize={25}
      onRowClick={openGroup} rowLabel={(r) => (groupBy === 'site' ? `Open ${r.key}` : `Filter to ${r.key}`)} csvName={`${account.slug}-ratings-by-${groupBy}`} />
    <div className="explorer-ai">
      <div className="ct"><span>Claude analysis of the slice</span>
        <span className="ctrl"><button type="button" className="btn sm" onClick={analyze} disabled={!total.comments || current?.state === 'running'}>
          {current?.state === 'running' ? 'Analyzing' : current?.state === 'done' ? 'Analyze again' : `Analyze ${total.comments.toLocaleString('en-US')} comments`}</button></span></div>
      {current?.state === 'done' && <SliceAnalysis result={current.result} error={current.error} />}
    </div>
  </div>
}


function SliceAnalysis({ result, error }: { result?: FeedbackSliceAnalysis; error?: string }) {
  if (error) return <p className="bad">Could not analyze: {error}</p>
  if (!result) return null
  if (result.status === 'off') return <p className="neutral">Claude analysis is not configured.</p>
  if (result.status === 'none') return <p className="neutral">No comments in the slice.</p>
  if (result.status === 'failed' || !result.summary) return <p className="bad">Could not analyze: {result.error ?? 'no result'}</p>
  const s = result.summary
  const n = s.counts.positive + s.counts.mixed + s.counts.negative || 1
  return <div className="slice-ai">
    <p className="slice-headline"><span className={`badge ${SENTIMENT_TONE[s.sentiment] === 'ok' ? 'bok' : SENTIMENT_TONE[s.sentiment] === 'warn' ? 'bwarn' : 'bbad'}`}>{s.sentiment[0].toUpperCase() + s.sentiment.slice(1)}</span> {s.headline}</p>
    <div className="sentiment-bar" role="img" aria-label={`${s.counts.positive} positive, ${s.counts.mixed} mixed, ${s.counts.negative} negative comments`}>
      {(['positive', 'mixed', 'negative'] as const).map((k) => s.counts[k] > 0 && <i key={k} className={SENTIMENT_TONE[k]} style={{ width: `${(s.counts[k] / n) * 100}%` }} title={`${k}: ${s.counts[k]}`} />)}
    </div>
    <p className="ks">{s.counts.positive} positive, {s.counts.mixed} mixed, {s.counts.negative} negative · {result.comments} comments{result.window ? `, ${result.window.from} to ${result.window.to}` : ''}{result.truncated ? `, newest ${result.comments} of ${result.ratings_with_comments}` : ''} · {result.model}{result.cached ? ', cached' : ''}</p>
    {s.themes.length > 0 && <div className="tw"><table><caption className="sr-only">Themes</caption>
      <thead><tr><th className="nosort l">Theme</th><th className="nosort l">Sentiment</th><th className="nosort">Comments</th><th className="nosort l">Locations</th><th className="nosort l">Quote</th></tr></thead>
      <tbody>{s.themes.map((th) => <tr key={th.theme}><td className="l nm">{th.theme}</td><td className={`l ${SENTIMENT_TONE[th.sentiment]}`}>{th.sentiment}</td><td>{th.mentions}</td>
        <td className="l">{th.locations.slice(0, 6).join(', ')}{th.locations.length > 6 ? ` +${th.locations.length - 6}` : ''}</td><td className="l wrap neutral">&ldquo;{th.quote}&rdquo;</td></tr>)}</tbody></table></div>}
    {s.watch.length > 0 && <div className="tw"><table><caption className="sr-only">Sites to watch</caption>
      <thead><tr><th className="nosort l">Site to watch</th><th className="nosort l">Reason</th></tr></thead>
      <tbody>{s.watch.map((w) => <tr key={w.location}><td className="l nm">{w.location}</td><td className="l wrap">{w.reason}</td></tr>)}</tbody></table></div>}
  </div>
}
