/**
 * One tab per business unit: KPIs (labor / vendor / margin by delivery model), weekly cost vs budget,
 * OT hours by site, the site breakdown table (with a delivery filter that mirrors the header) and the
 * per-site trend grids (delivery-aware: Labor % vs target for self-performed sites, Cost % + margin for
 * subcontracted ones; cost vs budget, agency & vendor cost, OT cost), sorted worst-first with a toggle.
 */
import { useState, type ReactNode } from 'react'
import type { ExecutiveBusinessUnit, ExecutiveDelivery } from '../../services/apiTypes'
import { ChartCard } from './ChartCard'
import { csvFileName, trendKind, type ExecMetric, type TableRow, type WeeklyTable } from './charts'
import { CategoryBars, ExecChart, MARGIN_COLOR, OT_COLOR, VENDOR_COLOR, type ExecSeries } from './ExecChart'
import { DELIVERY_LABEL, DELIVERY_OPTIONS, WeekIndex, costPctOf, costPctTone, deliveryOf, fmtHours, fmtMoney, fmtSignedMoney, isSubcontracted, laborOf, laborPctOf, lpClass, marginOf, marginPctOf, marginTone, otHoursOf, otPayOf, pctChange, ppBadgeTone, round1, signed, sumRows, totalCostOf, varBadgeTone, varianceTone, withAlpha, type Tone } from './model'
import { Badge, Card, Dash, Est, Kpi, Ks, Table, Wow } from './pieces'
import { Headline, RatioTrendCard, headlineValue, weeklySeries } from './trends'

type SiteSort = 'worst' | 'name'

/** Sort toggle shared by the site grids: worst-first (highest value) or A-Z. */
function SortToggle({ sort, onSort }: { sort: SiteSort; onSort: (s: SiteSort) => void }) {
  return <div className="seg" role="group" aria-label="Sort sites">
    <button type="button" className={sort === 'worst' ? 'on' : ''} aria-pressed={sort === 'worst'} onClick={() => onSort('worst')}>Worst first</button>
    <button type="button" className={sort === 'name' ? 'on' : ''} aria-pressed={sort === 'name'} onClick={() => onSort('name')}>A–Z</button>
  </div>
}

const sortSites = <T extends { site: string; worst: number | null }>(items: T[], sort: SiteSort): T[] => [...items].sort((a, b) => (sort === 'name' ? a.site.localeCompare(b.site) : (b.worst ?? -Infinity) - (a.worst ?? -Infinity) || a.site.localeCompare(b.site)))

/** A single-series site card (cost vs budget %, vendor $, OT $) with its weekly table. */
function SiteMetricCard({ site, tag, color, metric, label, values, note, estimated, target, suffix, tone, idx, week, csvKey }: { site: string; tag?: ReactNode; color: string; metric: ExecMetric; label: string; values: (number | null)[]; /** A tooltip line under every week (e.g. "Included in labor cost"). */ note?: string; estimated?: boolean[]; target?: { value: number; label: string }; suffix?: string; tone?: string; idx: WeekIndex; week: string; csvKey: string }) {
  const series: ExecSeries[] = [{ id: 'v', label, values, color, primary: true }]
  const table: WeeklyTable = {
    columns: [{ key: 'week', header: 'Week', kind: 'text' }, { key: 'value', header: label, kind: metric === 'pct' ? 'pct' : 'dollars' }, { key: 'est', header: 'Basis', kind: 'flag' }],
    rows: idx.weeks.map((w, i): TableRow => ({ week: `${w}${idx.isPartial(w) ? ' (in progress)' : ''}`, value: values[i], est: Boolean(estimated?.[i]) })),
  }
  return <ChartCard compact title={site} subtitle={tag} csvName={csvFileName(`${site}-${csvKey}`, week)} table={table}
    headline={<Headline metric={metric} values={values} weeks={idx.weeks} selected={week} estimated={estimated} tone={tone} suffix={suffix} />}
    chart={(h) => <ExecChart weeks={idx.weeks} selectedWeek={week} partialWeeks={idx.partialWeeks} estimated={estimated} metric={metric} series={series} target={target} height={h} extras={note ? (i) => (values[i] !== null ? [note] : []) : undefined} ariaLabel={`${site}: ${label} by week`} />} />
}

export function BuSiteTab({ idx, week, bu, delivery, onDelivery }: { idx: WeekIndex; week: string; bu: ExecutiveBusinessUnit; delivery: ExecutiveDelivery; onDelivery: (d: ExecutiveDelivery) => void }) {
  const color = bu.color
  const budgetColor = withAlpha(color, '44')
  const pw = idx.prevWeek(week)
  const rows = idx.buRows(week, bu.name)
  const prev = pw ? idx.buRows(pw, bu.name) : null
  const cur = idx.buSum(week, bu.name), prv = pw ? idx.buSum(pw, bu.name) : null
  const varH = pctChange(cur.hours, cur.budHours)
  const laborPct = laborPctOf(cur)
  const ppVsTarget = laborPct - bu.target_pct
  const otp = cur.hours ? (cur.ot / cur.hours) * 100 : 0
  const wD = prv && prv.dollars ? pctChange(cur.dollars, prv.dollars) : null
  const wH = prv && prv.hours ? pctChange(cur.hours, prv.hours) : null
  const wOT = prv && prv.ot ? pctChange(cur.ot, prv.ot) : null
  const wSub = prv && prv.vendor ? pctChange(cur.vendor, prv.vendor) : null
  const ppTone: Tone = ppVsTarget > 5 ? 'bad' : ppVsTarget > 0 ? 'warn' : 'ok'
  const costPct = costPctOf(cur)
  const [sort, setSort] = useState<SiteSort>('worst')

  // Weekly cost vs budget (paired bars, one dollar axis)
  const buSeries = weeklySeries(idx, (w) => idx.buSum(w, bu.name))
  const budgets = idx.weeks.map((w) => { const s = idx.buSum(w, bu.name); return s.sites && s.budDollars > 0 ? Math.round(s.budDollars) : null })
  const costSeries: ExecSeries[] = [
    { id: 'budget', label: 'Budget', values: budgets, color: budgetColor, kind: 'bar' },
    { id: 'actual', label: 'Actual (labor + vendor)', values: buSeries.dollars, color, kind: 'bar' },
  ]
  const costTable: WeeklyTable = {
    columns: [{ key: 'week', header: 'Week', kind: 'text' }, { key: 'actual', header: 'Actual cost', kind: 'dollars' }, { key: 'budget', header: 'Budget', kind: 'dollars' }, { key: 'var', header: 'Variance', kind: 'dollars' }, { key: 'var_pct', header: 'Var %', kind: 'pct' }, { key: 'est', header: 'Basis', kind: 'flag' }],
    rows: idx.weeks.map((w, i): TableRow => { const a = buSeries.dollars[i], b = budgets[i]; return { week: `${w}${idx.isPartial(w) ? ' (in progress)' : ''}`, actual: a, budget: b, var: a !== null && b !== null ? a - b : null, var_pct: a !== null && b ? round1(((a - b) / b) * 100) : null, est: buSeries.estimated[i] } }),
  }
  // OT hours by site (horizontal bar)
  const otRows = rows.filter((r) => otHoursOf(r) > 0).sort((a, b) => otHoursOf(b) - otHoursOf(a))

  const sorted = [...rows].sort((a, b) => totalCostOf(b) - totalCostOf(a))
  const maxD = Math.max(...sorted.map(totalCostOf), 1)
  const allSites = idx.buSites(bu.name)
  const selfSites = idx.selfSites(bu.name)
  const subSites = idx.subSites(bu.name)
  const siteRows = (site: string) => idx.weeks.flatMap((w) => { const r = idx.site(w, site); return r ? [r] : [] })
  const siteSeries = (site: string) => weeklySeries(idx, (w) => { const r = idx.site(w, site); return r ? sumRows([r]) : null })
  const tagOf = (site: string): ReactNode => { const sub = subSites.includes(site) && !selfSites.includes(site); return sub ? <span className="dtag sub">Subcontracted</span> : subSites.includes(site) ? <span className="dtag self">Self-performed · agency</span> : <span className="dtag self">Self-performed</span> }
  // Delivery-aware ratio cards, worst first by the headline value (labor % or cost %).
  const ratioCards = sortSites(allSites.map((site) => {
    const s = siteSeries(site)
    const kind = trendKind(siteRows(site))
    const primary = kind === 'labor' ? s.laborPct : s.costPct
    const h = headlineValue(primary, idx.weeks, week)
    return { site, s, kind, worst: h.value, tone: h.value === null ? 'neutral' : lpClass(bu, h.value) }
  }), sort)
  const budgetCards = sortSites(allSites.map((site) => {
    const values = idx.weeks.map((w) => { const r = idx.site(w, site); return r && r.budget_dollars > 0 ? round1((totalCostOf(r) / r.budget_dollars) * 100) : null })
    const h = headlineValue(values, idx.weeks, week)
    return { site, values, estimated: idx.weeks.map((w) => Boolean(idx.site(w, site)?.sub_estimated)), worst: h.value, tone: h.value === null ? 'neutral' : h.value > 103 ? 'bad' : h.value > 100 ? 'warn' : 'ok' }
  }), sort)
  const vendorCards = sortSites(subSites.map((site) => {
    const values = idx.weeks.map((w) => { const r = idx.site(w, site); return r && r.sub_dollars > 0 ? Math.round(r.sub_dollars) : null })
    const h = headlineValue(values, idx.weeks, week)
    return { site, values, estimated: idx.weeks.map((w) => Boolean(idx.site(w, site)?.sub_estimated)), worst: h.value, model: selfSites.includes(site) ? 'agency' : 'subcontracted' }
  }), sort)
  const otCards = sortSites(selfSites.map((site) => {
    // Full OT pay (otPayOf), the executives' "OT cost"; included in labor cost, never added to it.
    const values = idx.weeks.map((w) => { const r = idx.site(w, site); return r && r.hours > 0 ? Math.round(otPayOf(r)) : null })
    const h = headlineValue(values, idx.weeks, week)
    return { site, values, worst: h.value }
  }), sort)

  const laborKpi = <Kpi label="Labor cost" value={fmtMoney(cur.labor)}>
    {cur.agency > 0 && <Ks>incl. {fmtMoney(cur.agency)} agency{cur.agencyEstimated && <Est />}</Ks>}
    <Ks tone={ppTone}>{signed(ppVsTarget)}pp vs {bu.target_pct.toFixed(1)}% target</Ks>
    {wD !== null && <Ks><Wow v={wD} bad /> WoW total cost</Ks>}
  </Kpi>
  const hoursKpi = <Kpi label="Total hours" value={fmtHours(cur.hours)}>
    <Ks tone={varianceTone(varH, true)}>{cur.budHours ? `${signed(varH)}% vs budget` : 'no hours budget'}</Ks>
    {wH !== null && <Ks><Wow v={wH} bad={false} /> WoW</Ks>}
  </Kpi>
  const laborPctKpi = <Kpi label="Labor %" value={`${laborPct.toFixed(1)}%`}>
    <Ks tone={ppTone}>{cur.selfInvoicing ? <>{fmtMoney(cur.selfInvoicing)} {cur.subSites > 0 ? 'self-performed ' : ''}invoicing{cur.invoicingEstimated && <Est label="~" />}</> : '—'}</Ks>
    {costPct !== null && <Ks tone={costPctTone(bu, cur)}>cost {costPct.toFixed(1)}% incl. vendor</Ks>}
  </Kpi>
  const otKpi = <Kpi label="OT hours" value={fmtHours(cur.ot)}>
    <Ks tone={otp > 15 ? 'bad' : otp > 8 ? 'warn' : 'ok'}>{otp.toFixed(1)}% of hrs</Ks>
    {wOT !== null && <Ks><Wow v={wOT} bad /> WoW</Ks>}
  </Kpi>
  const vendorKpi = <Kpi label="Vendor cost" value={cur.vendor > 0 ? <>{fmtMoney(cur.vendor)}{cur.vendorEstimated && <Est />}</> : '—'}>
    <Ks>{cur.subSites > 0 ? `${cur.subSites} subcontracted ${cur.subSites === 1 ? 'site' : 'sites'}` : cur.agency > 0 ? 'agency counted in labor' : 'no subcontracted sites'}</Ks>
    {wSub !== null && <Ks><Wow v={wSub} bad /> WoW</Ks>}
  </Kpi>
  const invoicingKpi = <Kpi label="Invoicing" value={fmtMoney(cur.invoicing)}>
    {cur.invoicingEstimated && <Ks>carried forward<Est /></Ks>}
    {costPct !== null && <Ks tone={costPctTone(bu, cur)}>cost {costPct.toFixed(1)}% of invoicing</Ks>}
  </Kpi>
  const marginKpi = <Kpi label="Margin" value={<span className={marginTone(cur)}>{fmtSignedMoney(marginOf(cur))}</span>}>
    <Ks tone={marginTone(cur)}>{cur.invoicing ? `${marginPctOf(cur)!.toFixed(1)}% of invoicing` : 'no invoicing'}</Ks>
    <Ks style={{ fontSize: 10 }}>total cost {fmtMoney(cur.dollars)}</Ks>
  </Kpi>
  const sitesKpi = <Kpi label="Sites" value={rows.length}><Ks>{cur.selfSites ? `${cur.subSites} subcontracted · ${cur.selfSites} with hours (agency)` : 'subcontracted'}</Ks>{wD !== null && <Ks><Wow v={wD} bad /> WoW cost</Ks>}</Kpi>

  return <div className="panel" role="tabpanel">
    {delivery === 'subcontracted'
      ? <div className="kpi-lg kpi4">{sitesKpi}{vendorKpi}{invoicingKpi}{marginKpi}</div>
      : delivery === 'self_perform'
        ? <div className="kpi-lg kpi4">{laborKpi}{hoursKpi}{laborPctKpi}{otKpi}</div>
        : <div className="kpi-lg kpi6">{laborKpi}{hoursKpi}{laborPctKpi}{otKpi}{vendorKpi}{marginKpi}</div>}
    <div className="chart-grid">
      <ChartCard title={`Weekly cost vs budget — ${bu.name}`} subtitle="Total cost (labor + vendor) against the apportioned budget, by week" legend={[{ label: 'Actual (labor + vendor)', color, kind: 'bar' }, { label: 'Budget', color: budgetColor, kind: 'bar' }]} table={costTable} csvName={csvFileName(`${bu.name}-cost-vs-budget`, week)}
        chart={(h) => <ExecChart weeks={idx.weeks} selectedWeek={week} partialWeeks={idx.partialWeeks} estimated={buSeries.estimated} metric="dollars" series={costSeries} height={h} ariaLabel={`${bu.name} weekly cost vs budget`} />} />
      <Card title="OT hours by site — selected week" className="chart-card">
        {otRows.length ? <CategoryBars labels={otRows.map((r) => r.site)} values={otRows.map((r) => Math.round(otHoursOf(r)))} colors={otRows.map(() => color)} format={(v) => `${Math.round(v).toLocaleString('en-US')} h`} height={Math.max(260, otRows.length * 30 + 40)} ariaLabel={`${bu.name} OT hours by site`} /> : <EmptyOt subcontracted={delivery === 'subcontracted' || (rows.length > 0 && rows.every(isSubcontracted))} />}
      </Card>
    </div>
    <Card title="Site breakdown — selected week">
      <div className="tbl-toolbar">
        <span className="tbl-note">{rows.length} {rows.length === 1 ? 'site' : 'sites'} · {cur.selfSites} self-performed · {cur.subSites} subcontracted</span>
        <label>Delivery
          <select aria-label="Delivery (site table)" value={delivery} onChange={(e) => onDelivery(e.target.value as ExecutiveDelivery)}>
            {DELIVERY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      </div>
      <Table ariaLabel={`${bu.name} site breakdown for the selected week`}>
        <thead><tr><th className="l">Site</th><th className="l">Delivery</th><th>Direct $</th><th>Agency sub</th><th>Vendor cost</th><th>Total cost</th><th>Labor %</th><th>Cost %</th><th>Margin</th><th>Budget</th><th>$ Var</th><th>WoW $</th><th>Hours</th><th>WoW Hrs</th><th>OT Hrs</th><th>OT %</th><th>WoW OT</th></tr></thead>
        <tbody>
          {sorted.map((r) => {
            const sub = isSubcontracted(r)
            const cost = totalCostOf(r)
            const vd = pctChange(cost, r.budget_dollars), op = r.hours ? (otHoursOf(r) / r.hours) * 100 : 0
            const sp = prev?.find((x) => x.site === r.site)
            const site = { dollars: cost, invoicing: r.invoicing, selfInvoicing: sub ? 0 : r.invoicing, labor: laborOf(r) }
            const siteLp = !sub && r.invoicing > 0 ? laborPctOf(site) : null
            const siteCp = costPctOf(site)
            const model = deliveryOf(r)
            return <tr key={r.site}>
              <td title={r.site_name}>{r.site}<div className="bar-mini"><div className="bar-fill" style={{ width: `${Math.round((cost / maxD) * 100)}%`, background: color, opacity: 0.4 }} /></div></td>
              <td className="l"><span className={`dtag ${sub ? 'sub' : 'self'}`} title={DELIVERY_LABEL[model]}>{DELIVERY_LABEL[model]}</span></td>
              <td>{sub ? <Dash /> : fmtMoney(r.direct_dollars)}</td>
              <td>{!sub && r.sub_dollars > 0 ? <>{fmtMoney(r.sub_dollars)}{r.sub_estimated && <Est label="~" />}</> : <Dash />}</td>
              <td>{sub && r.sub_dollars > 0 ? <>{fmtMoney(r.sub_dollars)}{r.sub_estimated && <Est label="~" />}</> : <Dash />}</td>
              <td><strong>{fmtMoney(cost)}</strong></td>
              <td>{siteLp !== null ? <span className={lpClass(bu, siteLp)}>{siteLp.toFixed(1)}%</span> : <Dash />}</td>
              <td>{siteCp !== null ? <span className={costPctTone(bu, site)}>{siteCp.toFixed(1)}%</span> : <Dash />}</td>
              <td>{r.invoicing > 0 ? <span className={marginTone(site)}>{fmtSignedMoney(marginOf(site))}</span> : <Dash />}</td>
              <td>{r.budget_dollars > 0 ? fmtMoney(r.budget_dollars) : '—'}</td>
              <td>{r.budget_dollars > 0 ? <Badge tone={varBadgeTone(vd)}>{signed(vd)}%</Badge> : '—'}</td>
              <td>{sp ? <Wow v={pctChange(cost, totalCostOf(sp))} bad /> : '—'}</td>
              <td>{sub ? <Dash /> : fmtHours(r.hours)}</td>
              <td>{sub ? <Dash /> : sp ? <Wow v={pctChange(r.hours, sp.hours)} bad={false} /> : '—'}</td>
              <td>{sub ? <Dash /> : fmtHours(otHoursOf(r))}</td><td>{sub ? <Dash /> : `${op.toFixed(1)}%`}</td>
              <td>{sub ? <Dash /> : sp ? <Wow v={pctChange(otHoursOf(r), otHoursOf(sp))} bad /> : '—'}</td>
            </tr>
          })}
          {!sorted.length && <tr><td colSpan={17} className="neutral" style={{ textAlign: 'center' }}>No {bu.name} sites with labor or vendor cost in this week</td></tr>}
        </tbody>
      </Table>
    </Card>
    <Card title={<span className="ct-row"><span>Labor % and cost % — trend by site</span><SortToggle sort={sort} onSort={setSort} /></span>} className="mt12">
      <p className="tbl-note" style={{ marginBottom: 8 }}>Self-performed sites: labor ÷ invoicing vs the {bu.target_pct}% target. Subcontracted sites: vendor cost ÷ invoicing with the weekly margin beneath. Each card expands to the full chart and its weekly table.</p>
      <div className="site-grid">
        {ratioCards.map((c) => <RatioTrendCard key={c.site} compact title={c.site} subtitle={tagOf(c.site)} csvKey={`${c.site}-${c.kind === 'labor' ? 'labor-pct' : 'cost-pct'}`} idx={idx} week={week} series={c.s} kind={c.kind} color={color} target={{ value: bu.target_pct, label: `Target ${bu.target_pct}%` }} headlineTone={c.tone} />)}
      </div>
    </Card>
    <Card title={<span className="ct-row"><span>Cost vs budget — trend by site</span><SortToggle sort={sort} onSort={setSort} /></span>} className="mt12">
      <div className="site-grid">
        {budgetCards.map((c) => <SiteMetricCard key={c.site} site={c.site} tag={tagOf(c.site)} color={color} metric="pct" label="Cost % of budget" values={c.values} estimated={c.estimated} target={{ value: 100, label: 'Budget' }} suffix="of budget" tone={c.tone} idx={idx} week={week} csvKey="cost-vs-budget" />)}
      </div>
    </Card>
    {subSites.length > 0 && <Card title={<span className="ct-row"><span>Agency &amp; vendor cost — trend by site</span><SortToggle sort={sort} onSort={setSort} /></span>} className="mt12">
      <div className="site-grid">
        {vendorCards.map((c) => <SiteMetricCard key={c.site} site={c.site} tag={<span className={`dtag ${c.model === 'agency' ? 'self' : 'sub'}`}>{c.model === 'agency' ? 'Agency labor' : 'Subcontracted'}</span>} color={VENDOR_COLOR} metric="dollars" label={c.model === 'agency' ? 'Agency cost' : 'Vendor cost'} values={c.values} estimated={c.estimated} idx={idx} week={week} csvKey="vendor-cost" />)}
      </div>
    </Card>}
    {selfSites.length > 0 && <Card title={<span className="ct-row"><span>OT cost — trend by site</span><SortToggle sort={sort} onSort={setSort} /></span>} className="mt12">
      <div className="site-grid">
        {otCards.map((c) => <SiteMetricCard key={c.site} site={c.site} tag={tagOf(c.site)} color={OT_COLOR} metric="dollars" label="OT cost (full OT pay)" values={c.values} note="Included in labor cost" idx={idx} week={week} csvKey="ot-cost" />)}
      </div>
    </Card>}
  </div>
}

const EmptyOt = ({ subcontracted }: { subcontracted: boolean }) => <div className="empty" style={{ height: 150 }} role="status"><strong>{subcontracted ? 'No OT on subcontracted sites' : 'No OT hours this week'}</strong><span>{subcontracted ? 'Subcontracted sites carry vendor cost, not hours.' : 'No site in this business unit recorded overtime.'}</span></div>
