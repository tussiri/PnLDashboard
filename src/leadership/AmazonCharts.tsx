import { ArrowDown, ArrowUp } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import type { LeadershipAccount, LeadershipRow } from '../services/apiTypes'
import { OtHoursChart, Sparkline, TrendChart, WeekBarsChart, useTokens } from './charts'
import { inSentence, rowsOfWeek, segmentLabel, useRows, vendorLabel } from './data'
import { hours, hours1, money, moneyK, pct, pts } from './format'
import { accountSummary, type AccountSummary, type LaborStatus, type MetricOptions, type Rollup, type SiteMetrics } from './metrics'
import { useFiscalTotals } from './FiscalHero'
import { weekEndOf, weekTick } from './routes'
import { ChartCard, Kpi, statusLabel, Swatch, toneOf } from './ui'

type Row = SiteMetrics<LeadershipRow>
/** Weeks in the trends (the CDO's Amazon report shows about a quarter). */
const WEEKS = 13
const keyOf = (r: { company?: string | null; job_number: string }) => `${r.company ?? ''}~${r.job_number}`

const shortDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** Labor % on a bar that ends a little past the target, the target ticked (the report's progress bar). */
function TargetBar({ value, target, label }: { value: number | null; target: number; label: string }) {
  const max = Math.max(target * 1.15, (value ?? 0) * 1.02)
  const at = (v: number) => `${Math.min(100, Math.max(0, (v / max) * 100))}%`
  const tone = value == null ? '' : value > target ? 'bad' : 'ok'
  return <div className={`tbar ${tone}`} role="img" aria-label={`${label}: ${pct(value)} against a target of ${pct(target)}`}>
    <i style={{ width: at(value ?? 0) }} /><b style={{ left: at(target) }} />
  </div>
}

/** "1.5pp under target", green under and red over. */
function GapBadge({ lp, target }: { lp: number | null; target: number }) {
  if (lp == null) return null
  const gap = (lp - target) * 100
  return <span className={`badge ${gap <= 0 ? 'bok' : 'bbad'}`}>{Math.abs(gap).toFixed(1)}pp {gap <= 0 ? 'under' : 'over'} target</span>
}

/** A change against the prior week: an arrow, the signed change and the word; up is bad for a cost. */
export function wowChange(cur: number | null, prior: number | null | undefined, kind: 'pct' | 'pp', word = 'WoW'): ReactNode {
  if (cur == null || prior == null) return null
  if (kind === 'pp') {
    const d = (cur - prior) * 100
    return <span className={d > 0.05 ? 'bad' : d < -0.05 ? 'ok' : ''}>{`${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}pp ${word}`}</span>
  }
  if (prior <= 0) return null
  const d = cur / prior - 1
  const Arrow = d >= 0 ? ArrowUp : ArrowDown
  return <span className={`wow ${d > 0.005 ? 'bad' : d < -0.005 ? 'ok' : ''}`}><Arrow size={11} aria-hidden="true" />{`${d >= 0 ? '+' : '−'}${(Math.abs(d) * 100).toFixed(1)}%${word ? ` ${word}` : ''}`}</span>
}

function Headline({ title, tag, span, lp, target, tiles, ytd }: { title: string; tag: string; span?: string; lp: number | null; target: number; tiles: ReactNode; ytd?: boolean }) {
  return <div className={`card ahead${ytd ? ' ahead--ytd' : ''}`}>
    <div className="ahead__top"><div className="seg-name">{title} <span className="neutral">· {tag}</span>{span && <span className="ahead__span">{span}</span>}</div>
      <GapBadge lp={lp} target={target} /></div>
    <div className="ahead__tiles">{tiles}</div>
    <TargetBar value={lp} target={target} label={`${title} ${tag}`} />
  </div>
}

/** The invoicing-weighted target across the business units: each unit's target weighted by its invoicing. */
export function blendedTarget(summary: AccountSummary<LeadershipRow>, fallback: number) {
  const billed = summary.segments.reduce((x, g) => x + g.rollup.invoice, 0)
  return billed > 0 ? summary.segments.reduce((x, g) => x + g.rollup.invoice * g.target, 0) / billed : fallback
}

/**
 * The Amazon report's top two cards: the business units combined this week, then the year to date, each with
 * total labor (agency included), invoicing, labor %, the invoicing-weighted target and OT, and a bar to the target.
 */
export function AmazonHeadline({ account, summary, prior, options, weekStart }: { account: LeadershipAccount; summary: AccountSummary<LeadershipRow>; prior: AccountSummary<LeadershipRow> | null
  options: MetricOptions; weekStart: string }) {
  const a = summary.account
  const p = prior?.account ?? null
  const blended = blendedTarget(summary, options.target)
  const ytd = useFiscalTotals(account, options, weekStart, 1)
  const names = summary.segments.map((g) => g.segment).join(' + ') || account.name
  const agency = inSentence(vendorLabel(account))
  const incl = (v: number) => (v > 0 ? `incl. ${money(v)} ${agency}` : undefined)
  const tip = `Invoicing-weighted: each ${segmentLabel(account)}'s target weighted by its invoicing`
  const lpTone = (lp: number | null, tgt: number) => (lp == null ? '' : lp > tgt ? 'bad' : 'ok')
  const ytdLp = ytd && ytd.revenue > 0 ? ytd.labor / ytd.revenue : null
  const ytdTarget = ytd && ytd.groupInvoice > 0 ? ytd.targetInvoice / ytd.groupInvoice : blended
  return <>
    <Headline title={names} tag="combined" lp={a.measurePct} target={blended}
      tiles={<>
        <Kpi label="Total labor" value={money(a.cost)} sub={<>{incl(a.vendor) && <div>{incl(a.vendor)}</div>}{wowChange(a.cost, p?.cost, 'pct', 'labor WoW')}</>} />
        <Kpi label="Invoicing" value={money(a.invoice)} />
        <Kpi label="Labor %" value={pct(a.measurePct)} tone={lpTone(a.measurePct, blended)} sub={wowChange(a.measurePct, p?.measurePct, 'pp')} />
        <Kpi label="Blended target" value={pct(blended)} sub="≤ is favorable" tip={tip} />
        <Kpi label="OT cost" value={money(a.otDollars)} sub={<>{hours(a.otHours)}h{p && <> · {wowChange(a.otDollars, p.otDollars, 'pct', '')}</>}</>} />
      </>} />
    {ytd && ytd.weeks > 0 && <Headline ytd title={names} tag="year to date" span={`${ytd.first ? shortDay(ytd.first) : ''} – ${shortDay(weekEndOf(weekStart))} · ${ytd.weeks} wks`} lp={ytdLp} target={ytdTarget}
      tiles={<>
        <Kpi label="YTD total labor" value={money(ytd.labor)} sub={incl(ytd.vendor)} />
        <Kpi label="YTD invoicing" value={money(ytd.revenue)} />
        <Kpi label="Labor %" value={pct(ytdLp)} tone={lpTone(ytdLp, ytdTarget)} />
        <Kpi label="Blended target" value={pct(ytdTarget)} sub="≤ is favorable" tip={tip} />
        <Kpi label="YTD OT cost" value={money(ytd.otDollars)} sub={`${hours(ytd.otHours)}h`} />
      </>} />}
  </>
}

/** One business unit on the overview: labor (agency included) against its target, invoicing, labor %, OT cost, and its sites. */
export function BuCard({ account, name, color, sites, rollup, target, status, otPrior, onOpen }: { account: LeadershipAccount; name: string; color: string; sites: Row[]; rollup: Rollup; target: number
  status: LaborStatus; otPrior: number | null; onOpen?: () => void }) {
  const lp = rollup.measurePct
  const gapTone = lp == null ? '' : lp > target ? 'bad' : 'ok'
  return <div className="card bu" style={{ borderLeftColor: color }}>
    <div className="seg-hdr"><div className="seg-name">{onOpen ? <button type="button" className="linkbtn" onClick={onOpen}>{name}</button> : name}</div>
      <span className="bu__n" style={{ color }}>{sites.length} site{sites.length === 1 ? '' : 's'}</span></div>
    <div className="kpi4">
      <Kpi small label="Labor cost" value={money(rollup.cost)} sub={<>{rollup.vendor > 0 && <div>incl. {money(rollup.vendor)} {inSentence(vendorLabel(account))}</div>}
        {lp != null && <span className={gapTone}>{pts(lp - target)} vs {pct(target)} target</span>}</>} />
      <Kpi small label="Invoicing" value={money(rollup.invoice)} />
      <Kpi small label="Labor %" value={pct(lp)} tone={toneOf(status)} sub={<><div className={toneOf(status)}>{statusLabel(status)}</div>target ≤{pct(target)}</>} />
      <Kpi small label="OT cost" value={money(rollup.otDollars)} sub={<><div>{hours(rollup.otHours)} hrs</div>{wowChange(rollup.otDollars, otPrior, 'pct')}</>} />
    </div>
    <div className="chips">{sites.map((r) => <span key={keyOf(r)} className={`chip ${toneOf(r.status)}`} title={`${r.site_name}: ${pct(r.measurePct)}`}>{siteCode(r.site_name)}</span>)}</div>
  </div>
}

/** A site's short name for a chip: the name without the account prefix ("Amazon - MCC1" reads "MCC1"). */
export const siteCode = (name: string) => name.replace(/^[A-Z][A-Za-z]+ ?- ?/, '')

/** One small labor % chart per group (the CDO's "Crane West: Labor %" row). */
export function GroupTrendGrid({ labels, series, current }: { labels: string[]; series: { name: string; target: number; values: (number | null)[] }[]; current: number }) {
  const t = useTokens()
  if (series.length < 2) return null
  return <div className="spark-grid groups">
    {series.map((s, i) => {
      const latest = s.values[current] ?? null
      return <div key={s.name} className="card">
        <div className="ct"><span style={{ color: t.series[i % t.series.length] }}>{s.name}</span><span className={toneOf(latest == null ? 'no_billing' : latest > s.target ? 'over' : 'on_target')}>{pct(latest)}</span></div>
        <div className="cw" style={{ height: 150 }}><TrendChart labels={labels} values={s.values} target={s.target} label={`${s.name} labor %`} /></div>
      </div>
    })}
  </div>
}

/**
 * The CDO Amazon report's site charts, for the sites shown: weekly labor against budget (labor at target
 * on the week's invoicing) and OT hours by site this week above the table; labor % and OT cost by site
 * over the last weeks below it.
 */
export function SiteCharts({ account, rows, options, weekStart, part }: { account: LeadershipAccount; rows: Row[]; options: MetricOptions; weekStart: string | undefined; part: 'top' | 'bottom' }) {
  const t = useTokens()
  const history = useRows(account.slug, WEEKS)
  const shown = useMemo(() => new Set(rows.map(keyOf)), [rows])
  const weeks = useMemo(() => (history.data?.weeks ?? []).filter((wk) => !weekStart || wk <= weekStart).sort().slice(-WEEKS).map((wk) => {
    const sites = accountSummary(rowsOfWeek(history.data?.rows, wk), options, []).sites.filter((r) => shown.has(keyOf(r)))
    return { week: wk, sites: new Map(sites.map((r) => [keyOf(r), r])),
      cost: sites.reduce((a, r) => a + r.cost, 0), budget: sites.reduce((a, r) => a + (r.invoice > 0 ? r.invoice * r.target : 0), 0) }
  }), [history.data, weekStart, options, shown])
  const labels = weeks.map((x) => weekTick(x.week))
  const current = weeks.findIndex((x) => x.week === weekStart)
  if (part === 'top') {
    const ot = rows.filter((r) => r.ot_hours > 0).sort((a, b) => b.ot_hours - a.ot_hours).slice(0, 20)
    return <div className="charts2">
      <ChartCard title="Weekly labor cost vs budget" height={220}
        legend={<><Swatch color={t.accent} label="Labor" /><Swatch color={t.accent2} label="Budget" /></>}
        chart={<WeekBarsChart labels={labels} values={weeks.map((x) => x.cost)} compare={weeks.map((x) => x.budget)} valueLabel="Labor" compareLabel="Budget" color={t.accent} current={current} />}
        table={<table><thead><tr><th className="nosort l">Week ending</th><th className="nosort">Labor</th><th className="nosort">Budget</th></tr></thead>
          <tbody>{weeks.map((x, i) => <tr key={x.week}><td className="l">{labels[i]}</td><td>{money(x.cost)}</td><td>{money(x.budget)}</td></tr>)}</tbody></table>} />
      <ChartCard title="OT hours by site" height={Math.max(160, ot.length * 22 + 40)}
        chart={<OtHoursChart labels={ot.map((r) => r.site_name)} values={ot.map((r) => r.ot_hours)} tones={ot.map((r) => (r.otPct > 0.15 ? 'bad' : 'warn'))}
          details={ot.map((r) => `${hours1(r.ot_hours)} OT hrs, ${pct(r.otPct)} of hours, ${money(r.ot_dollars)}`)} />}
        table={<table><thead><tr><th className="nosort l">Site</th><th className="nosort">OT hrs</th><th className="nosort">OT %</th></tr></thead>
          <tbody>{ot.map((r) => <tr key={keyOf(r)}><td className="l">{r.site_name}</td><td>{hours1(r.ot_hours)}</td><td>{pct(r.otPct)}</td></tr>)}</tbody></table>} />
    </div>
  }
  if (weeks.length < 2) return null
  const sites = [...rows].filter((r) => r.role === 'site').sort((a, b) => a.site_name.localeCompare(b.site_name, 'en-US', { numeric: true }))
  const series = (r: Row, f: (x: Row) => number | null) => weeks.map((x) => { const s = x.sites.get(keyOf(r)); return s ? f(s) : null })
  const grid = (title: string, f: (x: Row) => number | null, format: (v: number) => string, tone: (r: Row, v: number | null) => string, min?: number) =>
    <div className="card"><div className="ct"><span>{title}</span></div>
      <div className="spark-grid">{sites.map((r) => {
        const values = series(r, f)
        const latest = values[current] ?? null
        return <div key={keyOf(r)} className="spark">
          <div className="spark__n" title={r.site_name}>{r.site_name}</div>
          <div className={`spark__v ${tone(r, latest)}`}>{latest == null ? '–' : format(latest)}</div>
          <div className="cw" style={{ height: 64 }}><Sparkline labels={labels} values={values} color={t.accent} current={current} format={format} min={min} /></div>
        </div>
      })}</div></div>
  return <>
    {grid('Labor % of invoicing by site', (x) => x.measurePct == null ? null : x.measurePct * 100, (v) => `${v.toFixed(0)}%`, (r) => toneOf(r.status))}
    {grid('OT cost by site', (x) => x.ot_dollars, (v) => moneyK(v), (r) => (r.otPct > 0.15 ? 'bad' : ''), 0)}
  </>
}
