import { useMemo, useState } from 'react'
import type { LeadershipAccount, LeadershipRow } from '../../services/apiTypes'
import { OtHoursChart, seriesColor, StackedMoneyChart, TrendLinesChart, useTokens } from '../charts'
import { isSubcontracted, useRows } from '../data'
import { hours, money, pct } from '../format'
import { rollup, siteMetrics, statusOf, type Rollup, type SiteMetrics } from '../metrics'
import { weekTick } from '../routes'
import { useLeadership } from '../state'
import { Badge, ChartCard, Empty, Kpi, LoadError, Pills, Skeleton, SortTable, Swatch, toneOf, type Column } from '../ui'

type Row = SiteMetrics<LeadershipRow>
const WEEKS = 13
const DELIVERY = [{ value: 'all', label: 'All delivery' }, { value: 'self', label: 'Self-performed' }, { value: 'sub', label: 'Subcontracted' }] as const
type Delivery = (typeof DELIVERY)[number]['value']
const ratio = (a: number, b: number) => (b ? a / b : null)
const signed = (v: number | null, digits = 1) => (v == null || !Number.isFinite(v) ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(digits)}`)

interface Unit { name: string; now: Rollup; prev: Rollup | null; target: number; sites: Row[]; subSites: number }

/** Business units (companies) across the featured accounts: a card per unit, weekly trends, the summary,
 * the delivery mix and overtime. The old Executive Overview, on the weekly leadership data. */
export function AnalyticsUnits() {
  const { featured, accountBySlug, optionsFor, weekStart } = useLeadership()
  const t = useTokens()
  const q = useRows('featured', WEEKS)
  const [scope, setScope] = useState('all')
  const [delivery, setDelivery] = useState<Delivery>('all')

  const rows: Row[] = useMemo(() => (q.data?.rows ?? []).filter((r) => r.role !== 'non_billed' && (scope === 'all' || r.account_slug === scope)
    && (delivery === 'all' || (delivery === 'sub') === isSubcontracted(r)))
    .map((r) => siteMetrics(r, optionsFor(accountBySlug(r.account_slug ?? undefined)))), [q.data, scope, delivery, optionsFor, accountBySlug])
  const weeks = q.data?.weeks ?? []
  const current = weekStart ?? weeks.at(-1)
  const prevWeek = weeks[weeks.indexOf(current ?? '') - 1]
  const names = useMemo(() => [...new Set(rows.map((r) => r.company ?? 'Unassigned'))].sort(), [rows])

  const units: Unit[] = useMemo(() => names.map((name) => {
    const inUnit = rows.filter((r) => (r.company ?? 'Unassigned') === name)
    const now = inUnit.filter((r) => r.week_start === current)
    const before = inUnit.filter((r) => r.week_start === prevWeek)
    const nowRoll = rollup(now, 0)
    const target = nowRoll.invoice ? now.reduce((a, r) => a + r.target * r.invoice, 0) / nowRoll.invoice : 0.645
    return { name, now: nowRoll, prev: before.length ? rollup(before, 0) : null, target, sites: now, subSites: now.filter(isSubcontracted).length }
  }), [names, rows, current, prevWeek])

  const series = useMemo(() => units.map((u, i) => {
    const byWeek = weeks.map((w) => rollup(rows.filter((r) => (r.company ?? 'Unassigned') === u.name && r.week_start === w), 0))
    return { name: u.name, color: seriesColor(t, i), byWeek }
  }), [units, weeks, rows, t])
  const avgTarget = units.reduce((a, u) => a + u.target * u.now.invoice, 0) / (units.reduce((a, u) => a + u.now.invoice, 0) || 1)

  if (q.error) return <LoadError error={q.error} onRetry={q.refetch} />
  if (!q.data) return <Skeleton height={500} />
  const accounts: LeadershipAccount[] = featured
  const total = rollup(rows.filter((r) => r.week_start === current), 0)
  const totalPrev = prevWeek ? rollup(rows.filter((r) => r.week_start === prevWeek), 0) : null

  type SummaryRow = Unit & { key: string }
  const summaryRows: SummaryRow[] = units.map((u) => ({ ...u, key: u.name }))
  const summaryCols: Column<SummaryRow>[] = [
    { key: 'name', header: 'Business unit', left: true, value: (u) => u.name, className: 'nm' },
    { key: 'inv', header: 'Invoicing', value: (u) => u.now.invoice, render: (u) => money(u.now.invoice) },
    { key: 'lab', header: 'Direct labor', value: (u) => u.now.labor, render: (u) => money(u.now.labor) },
    { key: 'ot', header: 'OT cost', value: (u) => u.now.otDollars, render: (u) => money(u.now.otDollars) },
    { key: 'tot', header: 'Total labor', value: (u) => u.now.cost, render: (u) => money(u.now.cost) },
    { key: 'lp', header: 'Labor %', value: (u) => u.now.measurePct, render: (u) => <span className={toneOf(statusOf(u.now.measurePct, u.target))}>{pct(u.now.measurePct)}</span> },
    { key: 'vs', header: 'vs target', value: (u) => (u.now.measurePct == null ? null : u.now.measurePct - u.target), render: (u) => (u.now.measurePct == null ? '–' : `${signed(u.now.measurePct - u.target)}pp`) },
    { key: 'wow', header: 'WoW', value: (u) => (u.prev?.measurePct != null && u.now.measurePct != null ? u.now.measurePct - u.prev.measurePct : null),
      render: (u) => (u.prev?.measurePct != null && u.now.measurePct != null ? `${signed(u.now.measurePct - u.prev.measurePct)}pp` : '–') },
    { key: 'ven', header: 'Vendor', value: (u) => u.sites.reduce((a, r) => a + (r.sub_week ?? 0), 0), render: (u) => money(u.sites.reduce((a, r) => a + (r.sub_week ?? 0), 0)) },
    { key: 'mgn', header: 'Margin', value: (u) => u.now.margin, render: (u) => <span className={u.now.margin < 0 ? 'bad' : ''}>{money(u.now.margin)} <span className="neutral">{pct(u.now.marginPct)}</span></span> },
    { key: 'hrs', header: 'Hours', value: (u) => u.now.hours, render: (u) => hours(u.now.hours) },
    { key: 'oth', header: 'OT hrs', value: (u) => u.now.otHours, render: (u) => hours(u.now.otHours) },
  ]
  const totalRow = <tr className="tot"><td className="l">Total</td><td>{money(total.invoice)}</td><td>{money(total.labor)}</td><td>{money(total.otDollars)}</td><td>{money(total.cost)}</td>
    <td>{pct(total.measurePct)}</td><td>{total.measurePct == null ? '–' : `${signed(total.measurePct - avgTarget)}pp`}</td>
    <td>{totalPrev?.measurePct != null && total.measurePct != null ? `${signed(total.measurePct - totalPrev.measurePct)}pp` : '–'}</td>
    <td>{money(rows.filter((r) => r.week_start === current).reduce((a, r) => a + (r.sub_week ?? 0), 0))}</td><td>{money(total.margin)}</td><td>{hours(total.hours)}</td><td>{hours(total.otHours)}</td></tr>

  interface Mix { key: string; unit: string; delivery: string; r: Rollup; vendor: number; count: number }
  const mix: Mix[] = units.flatMap((u) => ([['Self-performed', u.sites.filter((r) => !isSubcontracted(r))], ['Subcontracted', u.sites.filter(isSubcontracted)]] as const)
    .filter(([, list]) => list.length).map(([label, list]) => ({ key: `${u.name}-${label}`, unit: u.name, delivery: label, r: rollup([...list], 0), vendor: list.reduce((a, r) => a + (r.sub_week ?? 0), 0), count: list.length })))
  const mixCols: Column<Mix>[] = [
    { key: 'unit', header: 'Business unit', left: true, value: (m) => m.unit },
    { key: 'del', header: 'Delivery', left: true, value: (m) => m.delivery },
    { key: 'n', header: 'Sites', value: (m) => m.count },
    { key: 'hrs', header: 'Hours', value: (m) => m.r.hours, render: (m) => hours(m.r.hours) },
    { key: 'lab', header: 'Labor $', value: (m) => m.r.labor, render: (m) => money(m.r.labor) },
    { key: 'ven', header: 'Vendor', value: (m) => m.vendor, render: (m) => money(m.vendor) },
    { key: 'inv', header: 'Invoicing', value: (m) => m.r.invoice, render: (m) => money(m.r.invoice) },
    { key: 'cp', header: 'Cost %', value: (m) => ratio(m.r.labor + m.vendor, m.r.invoice), render: (m) => pct(ratio(m.r.labor + m.vendor, m.r.invoice)) },
    { key: 'mgn', header: 'Margin', value: (m) => m.r.margin, render: (m) => <span className={m.r.margin < 0 ? 'bad' : ''}>{money(m.r.margin)}</span> },
  ]
  const otTop = rows.filter((r) => r.week_start === current && r.ot_hours > 0).sort((a, b) => b.ot_hours - a.ot_hours).slice(0, 15)
  const labels = weeks.map(weekTick)

  return <>
    <div className="ctrl filters">
      <label htmlFor="bu-scope">Accounts</label>
      <select id="bu-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
        <option value="all">All key accounts</option>{accounts.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
      </select>
      <Pills label="Delivery" options={DELIVERY.map((d) => ({ value: d.value, label: d.label }))} value={delivery} onChange={setDelivery} />
    </div>
    {!units.length ? <Empty>No data for this week.</Empty> : <>
      <div className="unit-grid">
        {units.map((u) => {
          const status = statusOf(u.now.measurePct, u.target)
          const vendor = u.sites.reduce((a, r) => a + (r.sub_week ?? 0), 0)
          const otChange = u.prev?.otDollars ? ratio(u.now.otDollars - u.prev.otDollars, u.prev.otDollars) : null
          return <div className="card" key={u.name}>
            <div className="seg-hdr"><div><div className="seg-name"><i className="dot" style={{ background: seriesColor(t, names.indexOf(u.name)) }} aria-hidden="true" />{u.name}</div><div className="seg-sub">{u.sites.length} sites{u.subSites ? `, ${u.subSites} subcontracted` : ''}</div></div><Badge status={status} /></div>
            <div className="kpi-grid3">
              <Kpi small label="Total labor" value={money(u.now.cost)} sub={u.now.measurePct == null ? undefined : `${signed(u.now.measurePct - u.target)}pp vs ${pct(u.target)}`} />
              <Kpi small label="Invoicing" value={money(u.now.invoice)} />
              <Kpi small label="Labor %" value={pct(u.now.measurePct)} tone={toneOf(status)} sub={u.prev?.measurePct != null && u.now.measurePct != null ? `${signed(u.now.measurePct - u.prev.measurePct)}pp WoW` : undefined} />
              <Kpi small label="OT cost" value={money(u.now.otDollars)} sub={`${hours(u.now.otHours)} hrs${otChange != null ? `, ${signed(otChange)}% WoW` : ''}`} />
              <Kpi small label="Vendor" value={money(vendor)} sub={u.subSites ? `${u.subSites} sites` : undefined} />
              <Kpi small label="Margin" value={money(u.now.margin)} tone={u.now.margin < 0 ? 'bad' : 'ok'} sub={pct(u.now.marginPct)} />
            </div>
            <div className="chips">{u.sites.slice().sort((a, b) => a.site_name.localeCompare(b.site_name)).slice(0, 10).map((r) => <span key={`${r.company}-${r.job_number}`} className="chip">{r.site_name.replace(/^[A-Z][A-Za-z]+ ?- ?/, '')}</span>)}
              {u.sites.length > 10 && <span className="chip neutral">+{u.sites.length - 10} more</span>}</div>
          </div>
        })}
      </div>
      <div className="charts2">
        <ChartCard title="Labor % by week" height={260}
          legend={<>{series.map((s) => <Swatch key={s.name} color={s.color} label={s.name} />)}<Swatch line label={`Avg target ${pct(avgTarget)}`} /></>}
          chart={<TrendLinesChart labels={labels} target={avgTarget} series={series.map((s) => ({ label: s.name, color: s.color, data: s.byWeek.map((r) => r.measurePct) }))} />}
          table={<table><thead><tr><th className="nosort l">Week</th>{series.map((s) => <th key={s.name} className="nosort">{s.name}</th>)}</tr></thead>
            <tbody>{weeks.map((w, i) => <tr key={w}><td className="l">{labels[i]}</td>{series.map((s) => <td key={s.name}>{pct(s.byWeek[i].measurePct)}</td>)}</tr>)}</tbody></table>} />
        <ChartCard title="OT cost by week" height={260}
          legend={<>{series.map((s) => <Swatch key={s.name} color={s.color} label={s.name} />)}</>}
          chart={<StackedMoneyChart labels={labels} series={series.map((s) => ({ label: s.name, color: s.color, data: s.byWeek.map((r) => r.otDollars) }))} />}
          table={<table><thead><tr><th className="nosort l">Week</th>{series.map((s) => <th key={s.name} className="nosort">{s.name}</th>)}</tr></thead>
            <tbody>{weeks.map((w, i) => <tr key={w}><td className="l">{labels[i]}</td>{series.map((s) => <td key={s.name}>{money(s.byWeek[i].otDollars)}</td>)}</tr>)}</tbody></table>} />
      </div>
      <div className="card"><div className="ct"><span>Business units this week</span></div>
        <SortTable caption="Business units this week" rows={summaryRows} columns={summaryCols} defaultSort={{ key: 'inv', dir: -1 }} total={totalRow} csvName="business-units" /></div>
      <div className="card"><div className="ct"><span>Delivery mix</span></div>
        <SortTable caption="Delivery mix" rows={mix} columns={mixCols} defaultSort={{ key: 'inv', dir: -1 }} csvName="delivery-mix" /></div>
      {otTop.length > 0 && <ChartCard title={`OT hours, top ${otTop.length} sites`} height={Math.max(160, otTop.length * 24 + 50)}
        legend={<><Swatch color={t.warn} label="OT hours" /><Swatch color={t.bad} label="Over 25% of hours" /></>}
        chart={<OtHoursChart labels={otTop.map((r) => r.site_name.replace(/^[A-Z][A-Za-z]+ ?- ?/, ''))} values={otTop.map((r) => r.ot_hours)} tones={otTop.map((r) => (r.otPct > 0.25 ? 'bad' : 'warn'))}
          details={otTop.map((r) => `${r.company}: ${r.ot_hours.toFixed(1)} OT hrs, ${pct(r.otPct)} of hours, ${money(r.ot_dollars)}`)} />}
        table={<table><thead><tr><th className="nosort l">Site</th><th className="nosort l">Business unit</th><th className="nosort">OT hrs</th><th className="nosort">OT %</th><th className="nosort">OT cost</th></tr></thead>
          <tbody>{otTop.map((r) => <tr key={`${r.company}-${r.job_number}`}><td className="l">{r.site_name}</td><td className="l">{r.company}</td><td>{r.ot_hours.toFixed(1)}</td><td>{pct(r.otPct)}</td><td>{money(r.ot_dollars)}</td></tr>)}</tbody></table>} />}
    </>}
  </>
}
