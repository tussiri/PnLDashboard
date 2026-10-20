import { useMemo } from 'react'
import type { LeadershipAccount, LeadershipRow } from '../services/apiTypes'
import { OtHoursChart, Sparkline, TrendChart, WeekBarsChart, useTokens } from './charts'
import { rowsOfWeek, useRows } from './data'
import { hours1, money, moneyK, pct } from './format'
import { accountSummary, type MetricOptions, type SiteMetrics } from './metrics'
import { weekTick } from './routes'
import { ChartCard, Swatch, toneOf } from './ui'

type Row = SiteMetrics<LeadershipRow>
/** Weeks in the trends (the CDO's Amazon report shows about a quarter). */
const WEEKS = 13
const keyOf = (r: { company?: string | null; job_number: string }) => `${r.company ?? ''}~${r.job_number}`

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
