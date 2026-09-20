/**
 * "OT Analysis" tab: OT KPIs, OT cost by BU (stacked, month ticks), OT % of hours by site, OT detail table and per-site
 * OT % cards. "OT cost" throughout is the full OT pay (`otPayOf`), the executives' original figure; direct labor is
 * all-in payroll, so it is included in labor cost and never added to total cost.
 */
import { useState } from 'react'
import { ChartCard } from './ChartCard'
import { csvFileName, type TableRow, type WeeklyTable } from './charts'
import { CategoryBars, ExecChart, type ExecSeries } from './ExecChart'
import { WeekIndex, fmtHours, fmtMoney, otHoursOf, otLabel, otPayOf, otTone, round1, totalCostOf, type Tone } from './model'
import { Card, Kpi, Swatch, Table, WowPlain } from './pieces'
import { Headline, headlineValue } from './trends'

export function OtAnalysisTab({ idx, week }: { idx: WeekIndex; week: string }) {
  const bus = idx.bus
  const pw = idx.prevWeek(week)
  const allSites = idx.rows(week)
  const prevSites = pw ? idx.rows(pw) : null
  const cur = idx.weekSum(week), prv = pw ? idx.weekSum(pw) : null
  const otPct = cur.hours ? (cur.ot / cur.hours) * 100 : 0
  const costWoW = prv && prv.otPay ? ((cur.otPay - prv.otPay) / prv.otPay) * 100 : null
  const hrsWoW = prv && prv.ot ? ((cur.ot - prv.ot) / prv.ot) * 100 : null
  const topSite = [...allSites].sort((a, b) => otPayOf(b) - otPayOf(a))[0]
  const [sort, setSort] = useState<'worst' | 'name'>('worst')

  const stack: ExecSeries[] = bus.map((bu) => ({ id: bu.key, label: bu.name, values: idx.weeks.map((w) => { const s = idx.buSum(w, bu.name); return s.sites ? Math.round(s.otPay) : null }), color: bu.color, kind: 'bar' as const }))
  const stackTable: WeeklyTable = {
    columns: [{ key: 'week', header: 'Week', kind: 'text' }, ...bus.map((bu) => ({ key: bu.key, header: bu.name, kind: 'dollars' as const })), { key: 'total', header: 'Total OT cost (full OT pay, included in labor cost)', kind: 'dollars' }],
    rows: idx.weeks.map((w, i): TableRow => ({ week: `${w}${idx.isPartial(w) ? ' (in progress)' : ''}`, ...Object.fromEntries(bus.map((bu) => [bu.key, stack.find((s) => s.id === bu.key)?.values[i] ?? null])), total: Math.round(idx.weekSum(w).otPay) })),
  }
  const sitesSorted = allSites.filter((r) => r.hours > 0).sort((a, b) => otHoursOf(b) / b.hours - otHoursOf(a) / a.hours)
  const pctValues = sitesSorted.map((r) => round1((otHoursOf(r) / r.hours) * 100))
  const pctColors = sitesSorted.map((r) => { const p = (otHoursOf(r) / r.hours) * 100; return p > 15 ? '#e88080' : p > 8 ? '#f0c060' : idx.color(r.bu) })
  const tableSites = allSites.filter((r) => r.hours > 0).sort((a, b) => otPayOf(b) - otPayOf(a))
  const trendSites = [...new Set(idx.weeks.flatMap((w) => idx.rows(w).filter((r) => r.hours > 0).map((r) => r.site)))]
  const trendCards = trendSites.map((site) => {
    const values = idx.weeks.map((w) => { const r = idx.site(w, site); return r && r.hours > 0 ? round1((otHoursOf(r) / r.hours) * 100) : null })
    const h = headlineValue(values, idx.weeks, week)
    return { site, values, worst: h.value, tone: (h.value === null ? 'neutral' : otTone(h.value)) as Tone }
  }).sort((a, b) => (sort === 'name' ? a.site.localeCompare(b.site) : (b.worst ?? -Infinity) - (a.worst ?? -Infinity) || a.site.localeCompare(b.site)))

  return <div className="panel" role="tabpanel">
    <div className="ot-kpis">
      <Kpi label="OT cost" value={fmtMoney(cur.otPay)}><div className="ks" title="Full OT pay: OT hrs × rate × 1.5 and DT hrs × rate × 2, from each site's average payroll rate. Direct labor is all-in payroll, so this is already inside labor cost and total cost.">full OT pay · included in labor cost</div><div className="ks">{costWoW !== null ? <WowPlain v={costWoW} suffix="WoW" /> : ''}</div></Kpi>
      <Kpi label="OT hours" value={fmtHours(cur.ot)}><div className="ks">{hrsWoW !== null ? <WowPlain v={hrsWoW} suffix="WoW" /> : ''}</div></Kpi>
      <Kpi label="OT % of hours" value={`${otPct.toFixed(1)}%`}><div className="ks"><span className={otTone(otPct)}>{otLabel(otPct)}</span></div></Kpi>
      <Kpi label="Top OT site" value={topSite ? topSite.site : '—'}><div className="ks">{topSite ? <>{fmtMoney(otPayOf(topSite))} full OT pay • {fmtHours(otHoursOf(topSite))} hrs</> : ''}</div></Kpi>
    </div>
    <div className="chart-grid">
      <ChartCard title="OT cost by BU — trend" subtitle="Full OT pay (OT hrs × rate × 1.5 + DT hrs × rate × 2, estimated from each site's average payroll rate) by business unit, stacked, by week · included in labor cost, not added to it" legend={bus.map((bu) => ({ label: bu.name, color: bu.color, kind: 'bar' as const }))} table={stackTable} csvName={csvFileName('ot-cost-by-bu', week)}
        chart={(h) => <ExecChart weeks={idx.weeks} selectedWeek={week} partialWeeks={idx.partialWeeks} metric="dollars" series={stack} stacked height={h} extras={() => ['Included in labor cost']} ariaLabel="OT cost (full OT pay) by business unit by week" />} />
      <Card title="OT % of hours by site — selected week" className="chart-card">
        {sitesSorted.length ? <CategoryBars labels={sitesSorted.map((r) => r.site)} values={pctValues} colors={pctColors} format={(v) => `${round1(v)}%`} height={Math.max(260, sitesSorted.length * 28 + 40)} ariaLabel="OT % of hours by site" /> : <div className="empty" style={{ height: 260 }} role="status"><strong>No sites with hours this week</strong></div>}
      </Card>
    </div>
    <Card title="OT detail — selected week" className="mb12">
      <Table ariaLabel="Overtime detail by site for the selected week">
        <thead><tr><th className="l">Site</th><th className="l">BU</th><th>OT hrs</th><th>OT %</th><th title="Full OT pay: OT hrs × rate × 1.5 and DT hrs × rate × 2, from the site's average payroll rate. Included in labor cost (direct labor is all-in payroll), not added to it.">OT cost (full OT pay)</th><th title="Full OT pay ÷ the site's total cost (direct + sub)">OT % of labor</th><th>WoW hrs</th><th>WoW cost</th></tr></thead>
        <tbody>
          {tableSites.map((r) => {
            const ot = otHoursOf(r)
            const otPay = otPayOf(r)
            const otPctSite = r.hours ? (ot / r.hours) * 100 : 0
            const cost = totalCostOf(r)
            const otCostPct = cost ? (otPay / cost) * 100 : 0
            const prev = prevSites?.find((x) => x.site === r.site)
            const prevPay = prev ? otPayOf(prev) : 0
            const hrsW = prev && otHoursOf(prev) ? ((ot - otHoursOf(prev)) / otHoursOf(prev)) * 100 : null
            const costW = prevPay ? ((otPay - prevPay) / prevPay) * 100 : null
            const color = idx.color(r.bu)
            return <tr key={r.site}>
              <td title={r.site_name}><Swatch color={color} small />{r.site}</td>
              <td style={{ color }}>{r.bu}</td>
              <td>{fmtHours(ot)}</td>
              <td className={otTone(otPctSite)}><strong>{otPctSite.toFixed(1)}%</strong></td>
              <td title="Included in labor cost">{otPay > 0 ? fmtMoney(otPay) : '—'}</td>
              <td>{otCostPct > 0 ? `${otCostPct.toFixed(1)}%` : '—'}</td>
              <td>{hrsW !== null ? <WowPlain v={hrsW} /> : '—'}</td>
              <td>{costW !== null ? <WowPlain v={costW} /> : '—'}</td>
            </tr>
          })}
          {!tableSites.length && <tr><td colSpan={8} className="neutral" style={{ textAlign: 'center' }}>No sites with hours in this week</td></tr>}
        </tbody>
      </Table>
    </Card>
    <Card title={<span className="ct-row"><span>OT % of hours — trend by site</span><div className="seg" role="group" aria-label="Sort sites"><button type="button" className={sort === 'worst' ? 'on' : ''} aria-pressed={sort === 'worst'} onClick={() => setSort('worst')}>Worst first</button><button type="button" className={sort === 'name' ? 'on' : ''} aria-pressed={sort === 'name'} onClick={() => setSort('name')}>A–Z</button></div></span>}>
      <div className="site-grid">
        {trendCards.map((c) => {
          const bu = idx.buOfSite(c.site) ?? ''
          const color = idx.color(bu)
          const series: ExecSeries[] = [{ id: 'ot', label: 'OT % of hours', values: c.values, color, primary: true }]
          const table: WeeklyTable = { columns: [{ key: 'week', header: 'Week', kind: 'text' }, { key: 'ot_pct', header: 'OT % of hours', kind: 'pct' }], rows: idx.weeks.map((w, i): TableRow => ({ week: `${w}${idx.isPartial(w) ? ' (in progress)' : ''}`, ot_pct: c.values[i] })) }
          return <ChartCard key={c.site} compact title={c.site} subtitle={<span className="site-bu" style={{ color }}>{bu}</span>} table={table} csvName={csvFileName(`${c.site}-ot-pct`, week)}
            headline={<Headline metric="pct" values={c.values} weeks={idx.weeks} selected={week} tone={c.tone} suffix="OT of hours" />}
            chart={(h) => <ExecChart weeks={idx.weeks} selectedWeek={week} partialWeeks={idx.partialWeeks} metric="pct" pctMax={40} series={series} target={{ value: 8, label: 'Watch 8%' }} height={h} ariaLabel={`${c.site}: OT % of hours by week`} />} />
        })}
      </div>
    </Card>
  </div>
}
