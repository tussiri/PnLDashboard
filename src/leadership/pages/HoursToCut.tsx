import { useMemo, useState } from 'react'
import type { LeadershipAccount, LeadershipRow } from '../../services/apiTypes'
import { CutTrendChart, useTokens } from '../charts'
import { segmentLabel, useRows, vendorLabel } from '../data'
import { hours1, rate } from '../format'
import { cutRow, cutSummary, siteMetrics, type AccountSummary, type CutRow, type MetricOptions } from '../metrics'
import { weekTick } from '../routes'
import { useLeadership } from '../state'
import { Empty, Kpi, Pills, Skeleton, Swatch } from '../ui'

type Row = CutRow<LeadershipRow>
const perDay = (h: number) => h / 7
/** A shift is eight hours. */
const shifts = (h: number) => h / 8

function SiteTrend({ account, row, options }: { account: LeadershipAccount; row: Row; options: MetricOptions }) {
  const q = useRows(account.slug, 8)
  const t = useTokens()
  const weeks = useMemo(() => (q.data?.rows ?? []).filter((r) => r.company === row.site.company && r.job_number === row.site.job_number)
    .sort((a, b) => a.week_start.localeCompare(b.week_start)).map((r) => ({ week: r.week_start, cut: cutRow(siteMetrics(r, options)) })), [q.data, row, options])
  if (!q.data) return <Skeleton height={170} />
  if (weeks.length < 2) return <Empty>No earlier weeks.</Empty>
  const v = (f: (c: Row) => number) => weeks.map((w) => (w.cut ? f(w.cut) : null))
  return <>
    <div className="legend"><Swatch color={t.accent2} label="Worked" /><Swatch color={t.warn} label="OT premium" /><Swatch color={t.muted} label={vendorLabel(account)} /><Swatch line label="Allowance" /></div>
    <div className="cw" style={{ height: 170 }}>
      <CutTrendChart labels={weeks.map((w) => weekTick(w.week))} worked={v((c) => c.worked)} premium={v((c) => c.otPremium)} sub={v((c) => c.subHours)} allowance={v((c) => c.allowance)} subLabel={vendorLabel(account)} />
    </div>
  </>
}

function CutSite({ account, row, options, showGroup, open, onToggle }: { account: LeadershipAccount; row: Row; options: MetricOptions; showGroup: boolean; open: boolean; onToggle: () => void }) {
  const over = row.gap > 0
  const scale = Math.max(row.total, row.allowance) * 1.06 || 1
  const w = (x: number) => `${Math.max(0, (x / scale) * 100)}%`
  const sub = vendorLabel(account)
  return <div className={`cut-row${open ? ' open' : ''}`}>
    <button type="button" className="cut-head" onClick={onToggle} aria-expanded={open}>
      <span className="cut-site">{row.site.job_number} {row.site.site_name}
        {showGroup && row.site.segment && <span className="cut-bu">{row.site.segment}</span>}
        {row.fixedByOt && <span className="cut-flag">OT alone covers it</span>}</span>
      {over
        ? <span className="cut-num bad">Cut {hours1(perDay(row.gap))} hrs/day<small>{hours1(row.gap)}h this week</small></span>
        : <span className="cut-num ok">On track<small>{hours1(perDay(-row.gap))} hrs/day of room</small></span>}
    </button>
    <div className="cut-bar" aria-hidden="true">
      <span className="seg worked" style={{ width: w(row.worked) }} />
      <span className="seg premium" style={{ width: w(row.otPremium) }} />
      <span className="seg sub" style={{ width: w(row.subHours) }} />
      <span className="mark" style={{ left: w(row.allowance) }}><small>target {hours1(row.allowance)}h</small></span>
    </div>
    <div className="cut-meta">
      <span>Worked <b>{hours1(row.worked)}h</b></span>
      {row.otPremium > 0 && <span>OT premium <b>{hours1(row.otPremium)}h</b> ({hours1(perDay(row.otPremium))}/day, {shifts(perDay(row.otPremium)).toFixed(1)} shifts)</span>}
      {row.subHours > 0 && <span>{sub} <b>{hours1(row.subHours)}h</b></span>}
      <span>Allowance <b>{hours1(row.allowance)}h</b></span>
      <span>Base rate <b>{rate(row.baseRate)}</b></span>
      <span>Avg rate <b>{rate(row.avgRate)}</b>{row.otDrag > 0.005 && <span className="warn"> +{rate(row.otDrag)} OT drag</span>}</span>
    </div>
    {open && <div className="cut-detail"><div className="ct"><span>{row.site.site_name}, last 8 weeks</span></div><SiteTrend account={account} row={row} options={options} /></div>}
  </div>
}

/** The weekly report's "Hours to cut to hit target", per site and grouped by BU (segment). */
export function HoursToCut({ account, summary, options }: { account: LeadershipAccount; summary: AccountSummary<LeadershipRow>; options: MetricOptions }) {
  const [scope, setScope] = useState('All')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const label = segmentLabel(account)
  const groups = [...new Set(summary.cut.rows.map((r) => r.site.segment ?? ''))].filter(Boolean)
  const order = (a: Row, b: Row) => (b.gap > 0 ? 1 : 0) - (a.gap > 0 ? 1 : 0) || b.gap - a.gap
  const shown = summary.cut.rows.filter((r) => scope === 'All' || r.site.segment === scope).sort(order)
  const s = cutSummary(shown)
  const toggle = (key: string) => setOpen((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next })
  const site = (r: Row, showGroup: boolean) => {
    const key = `${r.site.company}~${r.site.job_number}`
    return <CutSite key={key} account={account} row={r} options={options} showGroup={showGroup} open={open.has(key)} onToggle={() => toggle(key)} />
  }
  const grouped = scope === 'All' && groups.length > 1
  if (!summary.cut.rows.length) return <Empty>No billed site with labor hours this week.</Empty>
  return <>
    <div className="kpi-lg">
      <Kpi label="Sites over allowance" value={<>{s.over}<span className="of"> of {s.rated}</span></>} tone={s.over ? 'bad' : 'ok'} sub={scope === 'All' ? groups.join(', ') : scope} />
      <Kpi label="Hours to cut" value={<>{hours1(perDay(s.cut))}<span className="of">/day</span></>} tone={s.cut > 0 ? 'bad' : 'ok'} sub={`${hours1(s.cut)}h across the week`} />
      <Kpi label="OT premium, sites over" value={<>{hours1(perDay(s.otPremiumOver))}<span className="of">/day</span></>} tone={s.otPremiumOver > 0 ? 'warn' : 'ok'} sub={`${shifts(perDay(s.otPremiumOver)).toFixed(1)} shifts a day, no coverage`} />
      <Kpi label="Fixed by OT alone" value={s.fixedByOt} tone={s.fixedByOt ? 'warn' : ''} sub={`of ${s.over} sites over`} />
    </div>
    {groups.length > 1 && <Pills label={label} options={['All', ...groups].map((g) => ({ value: g, label: g }))} value={scope} onChange={setScope} />}
    <div className="card cut">
      {grouped
        ? groups.map((g) => {
          const list = shown.filter((r) => r.site.segment === g)
          const gs = cutSummary(list)
          return <section key={g} className="cut-grp" aria-label={g}>
            <div className="cut-grp-h"><b>{g}</b>
              <span><b>{gs.over}</b> of {gs.rated} over</span>
              <span>Cut <b>{hours1(perDay(gs.cut))}</b> hrs/day</span>
              <span>OT premium <b>{hours1(perDay(gs.otPremiumOver))}</b> hrs/day</span>
              {gs.fixedByOt > 0 && <span><b>{gs.fixedByOt}</b> fixed by OT alone</span>}</div>
            {list.map((r) => site(r, false))}
          </section>
        })
        : shown.map((r) => site(r, scope === 'All'))}
      {!s.over && <p className="empty">Every site{scope === 'All' ? '' : ` in ${scope}`} is within its allowance this week.</p>}
    </div>
    {summary.cut.unrated > 0 && <p className="foot">Not rated, no labor hours: {summary.cut.unrated} billed sites</p>}
  </>
}
