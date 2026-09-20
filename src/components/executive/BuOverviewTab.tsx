/**
 * "BU Overview" tab: BU cards (labor, vendor cost, margin), total labor % / cost % and OT cost trends,
 * per-BU labor % sparklines, BU summary table, delivery mix, the by-sub-account table and the QA slots.
 */
import type { ExecutiveDelivery, ExecutiveLaborPl, ExecutiveSubAccount, ExecutiveVendorBlock } from '../../services/apiTypes'
import { ChartCard, type LegendItem } from './ChartCard'
import { csvFileName, dollarClampMax, fmtCurrency, trendKind, type TableRow, type WeeklyTable } from './charts'
import { ExecChart, OT_COLOR, TOTAL_COLOR, VENDOR_COLOR, type ExecSeries } from './ExecChart'
import { type BuSum, WeekIndex, averageTarget, capList, costPctOf, costPctTone, deliverySplit, fmtHours, fmtMoney, fmtSignedMoney, laborPctOf, lpClass, lpLabel, marginOf, marginPctOf, marginTone, monthYear, pctChange, ppBadgeTone, signed, subAccountRollup, withAlpha } from './model'
import { Badge, Card, EmptySlot, Est, Kpi, Ks, Swatch, Table, Wow } from './pieces'
import { RatioTrendCard, weeklySeries } from './trends'
import { fmtDate } from '../../utils'

const pctOrDash = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`)

/** Margin cell: signed dollars with the % of invoicing, toned. */
const MarginCell = ({ s }: { s: Pick<BuSum, 'dollars' | 'invoicing'> }) => {
  const p = marginPctOf(s)
  return <span className={marginTone(s)}>{fmtSignedMoney(marginOf(s))}{p !== null && <span style={{ fontSize: 10 }}> ({p.toFixed(1)}%)</span>}</span>
}

export function BuOverviewTab({ idx, week, qa, delivery, subAccounts, onSelectSubAccount, vendor }: {
  idx: WeekIndex; week: string; qa: ExecutiveLaborPl['qa']; delivery: ExecutiveDelivery
  /** The account's sub-accounts when it has a second level and none is selected (drives the by-sub-account table). */
  subAccounts: ExecutiveSubAccount[] | null
  onSelectSubAccount?: (name: string) => void
  /** Vendor cost projection + live AP look; rendered as a card when the API sends it. */
  vendor?: ExecutiveVendorBlock | null
}) {
  const bus = idx.bus
  const pw = idx.prevWeek(week)
  const showLabor = delivery !== 'subcontracted'
  // Trends: the total and one small multiple per BU, every card on the same 0-120 % axis (see trends.tsx).
  const total = weeklySeries(idx, (w) => idx.weekSum(w))
  const totalKind = trendKind(idx.weeks.flatMap((w) => idx.rows(w)))
  const avgTarget = averageTarget(bus)
  // "OT cost" is the full OT pay (otPayOf), the executives' original figure; it is inside labor cost, not added to it.
  const otSeries: ExecSeries[] = [{ id: 'ot', label: 'OT cost (full OT pay)', values: total.otPay, color: OT_COLOR, primary: true }]
  const otTable: WeeklyTable = {
    columns: [{ key: 'week', header: 'Week', kind: 'text' }, { key: 'ot', header: 'OT cost (full OT pay, included in labor cost)', kind: 'dollars' }, { key: 'ot_hours', header: 'OT hours', kind: 'number' }, { key: 'hours', header: 'Hours', kind: 'number' }, { key: 'ot_pct', header: 'OT % of hours', kind: 'pct' }],
    rows: idx.weeks.map((w, i): TableRow => { const su = total.sums[i]; return { week: `${w}${idx.isPartial(w) ? ' (in progress)' : ''}`, ot: total.otPay[i], ot_hours: su ? Math.round(su.ot) : null, hours: total.hours[i], ot_pct: su && su.hours ? Math.round((su.ot / su.hours) * 1000) / 10 : null } }),
  }

  // Summary table totals
  const sums = bus.map((bu) => ({ bu, s: idx.buSum(week, bu.name), ps: pw ? idx.buSum(pw, bu.name) : null }))
  const tot = idx.weekSum(week)
  const totalLaborPct = laborPctOf(tot)
  const totPp = totalLaborPct - averageTarget(bus)
  const ptot = pw ? idx.weekSum(pw).dollars : null
  const anyInvEst = sums.some((x) => x.s.invoicingEstimated)

  // Delivery mix per BU (and across BUs when there is more than one).
  const mixes = bus.map((bu) => ({ key: bu.key, name: bu.name, color: bu.color, mix: deliverySplit(idx.buRows(week, bu.name)) }))
  if (bus.length > 1) mixes.push({ key: '__all', name: 'All business units', color: TOTAL_COLOR, mix: deliverySplit(idx.rows(week)) })

  // By sub-account (only when the account has a second level and none is selected).
  const rollup = subAccounts ? subAccountRollup(idx.rows(week), pw ? idx.rows(pw) : null) : []
  const subRows = subAccounts ? [...rollup, ...subAccounts.filter((s) => !rollup.some((r) => r.name === s.name)).map((s) => ({ name: s.name, s: null, prev: null, wowCost: null, sites: s.sites }))] : []
  const noRowsHint = delivery === 'subcontracted' ? 'No subcontracted sites' : delivery === 'self_perform' ? 'No self-performed sites' : 'No labor or vendor cost in this week'

  return <div className="panel" role="tabpanel">
    <div className="bu-grid">
      {bus.map((bu) => {
        const s = idx.buSum(week, bu.name), ps = pw ? idx.buSum(pw, bu.name) : null
        const lp = laborPctOf(s)
        const lpVsTarget = lp - bu.target_pct
        const wdv = ps && ps.dollars ? pctChange(s.dollars, ps.dollars) : null
        const costPct = costPctOf(s)
        const sites = idx.buSitesIn(week, bu.name)
        const pills = capList(sites)
        const laborKpi = <Kpi label="Labor cost" value={fmtMoney(s.labor)}>
          {s.agency > 0 && <Ks>incl. {fmtMoney(s.agency)} agency{s.agencyEstimated && <Est />}</Ks>}
          <Ks tone={lpVsTarget > 0 ? 'bad' : 'ok'}>{signed(lpVsTarget)}pp vs {bu.target_pct}% target</Ks>
          {delivery === 'all' && s.subSites > 0 && <Ks>{s.selfSites} self-performed {s.selfSites === 1 ? 'site' : 'sites'} · {fmtMoney(s.selfInvoicing)} invoicing</Ks>}
        </Kpi>
        const invoicingKpi = <Kpi label="Invoicing" value={fmtMoney(s.invoicing)}>{s.invoicingEstimated && <Ks>carried forward<Est /></Ks>}{costPct !== null && <Ks tone={costPctTone(bu, s)}>cost {costPct.toFixed(1)}% of invoicing</Ks>}</Kpi>
        const laborPctKpi = <Kpi label="Labor %" value={`${lp.toFixed(1)}%`}>
          <Ks tone={lpClass(bu, lp)}>{lpLabel(bu, lp)}</Ks>
          <Ks style={{ fontSize: 10 }}>target ≤{bu.target_pct}%</Ks>
        </Kpi>
        const otKpi = <Kpi label="OT cost" value={s.otPay > 0 ? fmtMoney(s.otPay) : `${fmtHours(s.ot)} hrs`}>
          <Ks style={{ fontSize: 10 }} title="Full OT pay: OT hrs × rate × 1.5 and DT hrs × rate × 2, from the site's average payroll rate. Direct labor is all-in payroll, so this is already inside labor cost and total cost.">full OT pay · included in labor cost</Ks>
          <Ks>{fmtHours(s.ot)} hrs</Ks>
          {wdv !== null && <Ks><Wow v={wdv} bad /> WoW</Ks>}
        </Kpi>
        const vendorKpi = <Kpi label="Vendor cost" value={s.vendor > 0 ? <>{fmtMoney(s.vendor)}{s.vendorEstimated && <Est />}</> : '—'}>
          <Ks>{s.subSites > 0 ? `${s.subSites} subcontracted ${s.subSites === 1 ? 'site' : 'sites'}` : s.agency > 0 ? 'agency counted in labor' : 'no subcontracted sites'}</Ks>
          {delivery === 'subcontracted' && wdv !== null && <Ks><Wow v={wdv} bad /> WoW</Ks>}
        </Kpi>
        const marginKpi = <Kpi label="Margin" value={<span className={marginTone(s)}>{fmtSignedMoney(marginOf(s))}</span>}>
          <Ks tone={marginTone(s)}>{s.invoicing ? `${marginPctOf(s)!.toFixed(1)}% of invoicing` : 'no invoicing'}</Ks>
          <Ks style={{ fontSize: 10 }}>invoicing − total cost {fmtMoney(s.dollars)}</Ks>
        </Kpi>
        const sitesKpi = <Kpi label="Sites" value={sites.length}>
          <Ks>{s.selfSites ? `${s.subSites} subcontracted · ${s.selfSites} with hours (agency)` : 'subcontracted'}</Ks>
          {costPct !== null && <Ks tone={costPctTone(bu, s)}>cost {costPct.toFixed(1)}% of invoicing</Ks>}
        </Kpi>
        return <div className="bu-card" key={bu.key} style={{ borderLeft: `3px solid ${bu.color}` }}>
          <div className="bu-hdr"><div className="bu-name">{bu.name}</div><div className="bu-tag" style={{ background: withAlpha(bu.color, '18'), color: bu.color }}>{sites.length} {sites.length === 1 ? 'site' : 'sites'}{delivery === 'all' && s.subSites > 0 ? ` · ${s.subSites} sub` : ''}</div></div>
          {delivery === 'subcontracted' || s.selfSites === 0
            ? <div className="kpi4">{sitesKpi}{vendorKpi}{invoicingKpi}{marginKpi}</div>
            : delivery === 'self_perform'
              ? <div className="kpi4">{laborKpi}{invoicingKpi}{laborPctKpi}{otKpi}</div>
              : <div className="kpi6">{laborKpi}{invoicingKpi}{laborPctKpi}{otKpi}{vendorKpi}{marginKpi}</div>}
          <div className="pills">{pills.shown.map((st) => <span className="pill" key={st}>{st}</span>)}{pills.more > 0 && <span className="pill pill--more" title={sites.slice(pills.shown.length).join(', ')}>+{pills.more} more</span>}</div>
        </div>
      })}
    </div>
    <div className="chart-grid">
      <RatioTrendCard title={totalKind === 'cost_margin' || !showLabor ? 'Cost % and margin — all business units' : 'Labor % and Cost % of invoicing — all business units'} subtitle={totalKind === 'cost_margin' || !showLabor ? 'Total cost incl. vendor ÷ invoicing, and invoicing − cost, by week' : 'Self-performed labor ÷ self-performed invoicing (target = BU average) and total cost incl. vendor ÷ all invoicing, by week'}
        csvKey="total-labor-cost-pct" idx={idx} week={week} series={total} kind={totalKind} color={TOTAL_COLOR} target={bus.length ? { value: Math.round(avgTarget * 10) / 10, label: `${bus.length > 1 ? 'Avg target' : 'Target'} ${Math.round(avgTarget * 10) / 10}%` } : undefined} showLabor={showLabor} />
      {showLabor && totalKind !== 'cost_margin'
        ? <ChartCard title="OT cost — trend" subtitle="Full OT pay (OT hrs × rate × 1.5 + DT hrs × rate × 2, estimated from each site's average payroll rate), all business units, by week · included in labor cost, not added to it" table={otTable} csvName={csvFileName('ot-cost-trend', week)}
            chart={(h) => <ExecChart weeks={idx.weeks} selectedWeek={week} partialWeeks={idx.partialWeeks} metric="dollars" series={otSeries} height={h} extras={(i) => { const su = total.sums[i]; return su && su.hours ? [`${fmtHours(su.ot)} OT of ${fmtHours(su.hours)} (${((su.ot / su.hours) * 100).toFixed(1)}%)`, 'Included in labor cost'] : [] }} ariaLabel="OT cost (full OT pay) by week" />} />
        : <Card title="OT cost — trend"><EmptySlot title="No OT on subcontracted sites" hint="Subcontracted sites carry vendor cost, not hours." height={260} /></Card>}
      {vendor && <VendorCostCard vendor={vendor} />}
    </div>
    <div className="chart-grid">
      {bus.map((bu) => {
        const s = weeklySeries(idx, (w) => idx.buSum(w, bu.name))
        const kind = trendKind(idx.weeks.flatMap((w) => idx.buRows(w, bu.name)))
        const sub = kind === 'cost_margin' || !showLabor
        return <RatioTrendCard key={bu.key} title={`${bu.name} — ${sub ? 'Cost % and margin' : 'Labor %'}`} titleColor={bu.color} csvKey={`${bu.name}-${sub ? 'cost-pct' : 'labor-pct'}`}
          subtitle={sub ? `${idx.subSites(bu.name).length} subcontracted ${idx.subSites(bu.name).length === 1 ? 'site' : 'sites'} · vendor cost and margin, no hours` : `Target ≤${bu.target_pct}% · high above ${bu.high_pct}%${idx.subSites(bu.name).length ? ' · Cost % includes the subcontracted sites' : ''}`}
          idx={idx} week={week} series={s} kind={sub ? 'cost_margin' : 'labor'} color={bu.color} target={{ value: bu.target_pct, label: `Target ${bu.target_pct}%` }} showLabor={showLabor} />
      })}
    </div>
    <Card title="BU summary — selected week">
      <Table ariaLabel="Business unit summary for the selected week">
        <thead><tr>
          <th className="l">BU</th><th>Invoicing</th>
          {showLabor && <><th>Direct labor</th><th title="Full OT pay (OT hrs × rate × 1.5, DT hrs × rate × 2), estimated from the site's average payroll rate. Included in Direct labor (all-in payroll), so it is not added to Labor $ or Total cost.">OT cost (full OT pay)</th><th>Agency sub</th><th>Labor $</th><th>Labor %</th><th>vs target</th><th>WoW pp</th></>}
          <th>Vendor cost</th><th>Total cost</th><th>Cost %</th><th>Margin</th><th>WoW cost</th>
          {showLabor && <><th>Hours</th><th>OT hrs</th></>}
        </tr></thead>
        <tbody>
          {sums.map(({ bu, s, ps }) => {
            const lp = laborPctOf(s)
            const lpVsTarget = lp - bu.target_pct
            const wlv = ps && ps.dollars ? pctChange(s.dollars, ps.dollars) : null
            const wlp = ps && ps.selfInvoicing ? lp - laborPctOf(ps) : null
            return <tr key={bu.key}>
              <td><Swatch color={bu.color} />{bu.name}</td>
              <td>{fmtMoney(s.invoicing)}{s.invoicingEstimated && <Est label="~" />}</td>
              {showLabor && <>
                <td>{fmtMoney(s.direct)}</td>
                <td title="Included in labor cost">{s.otPay > 0 ? fmtMoney(s.otPay) : '—'}</td>
                <td>{s.agency > 0 ? <>{fmtMoney(s.agency)}{s.agencyEstimated && <Est label="~" />}</> : '—'}</td>
                <td>{fmtMoney(s.labor)}</td>
                <td className={lpClass(bu, lp)}><strong>{lp.toFixed(1)}%</strong></td>
                <td><Badge tone={ppBadgeTone(lpVsTarget)}>{signed(lpVsTarget)}pp</Badge></td>
                <td>{wlp !== null ? <span className={`wow ${wlp > 0 ? 'up-bad' : 'dn-ok'}`}>{signed(wlp)}pp</span> : '—'}</td>
              </>}
              <td>{s.vendor > 0 ? <>{fmtMoney(s.vendor)}{s.vendorEstimated && <Est label="~" />}</> : '—'}</td>
              <td><strong>{fmtMoney(s.dollars)}</strong></td>
              <td className={costPctTone(bu, s)}>{pctOrDash(costPctOf(s))}</td>
              <td><MarginCell s={s} /></td>
              <td>{wlv !== null ? <Wow v={wlv} bad /> : '—'}</td>
              {showLabor && <><td>{fmtHours(s.hours)}</td><td>{fmtHours(s.ot)}</td></>}
            </tr>
          })}
          <tr className="tot">
            <td>Total</td><td>{fmtMoney(tot.invoicing)}{anyInvEst && <Est label="~" />}</td>
            {showLabor && <>
              <td>{fmtMoney(tot.direct)}</td>
              <td title="Included in labor cost">{tot.otPay > 0 ? fmtMoney(tot.otPay) : '—'}</td>
              <td>{tot.agency > 0 ? <>{fmtMoney(tot.agency)}{tot.agencyEstimated && <Est label="~" />}</> : '—'}</td>
              <td>{fmtMoney(tot.labor)}</td>
              <td><strong>{totalLaborPct.toFixed(1)}%</strong></td>
              <td><Badge tone={ppBadgeTone(totPp)}>{signed(totPp)}pp</Badge></td>
              <td>—</td>
            </>}
            <td>{tot.vendor > 0 ? <>{fmtMoney(tot.vendor)}{tot.vendorEstimated && <Est label="~" />}</> : '—'}</td>
            <td>{fmtMoney(tot.dollars)}</td>
            <td>{pctOrDash(costPctOf(tot))}</td>
            <td><MarginCell s={tot} /></td>
            <td>{ptot ? <Wow v={pctChange(tot.dollars, ptot)} bad /> : '—'}</td>
            {showLabor && <><td>{fmtHours(tot.hours)}</td><td>{fmtHours(tot.ot)}</td></>}
          </tr>
        </tbody>
      </Table>
    </Card>
    <Card title="Delivery mix — selected week" className="mt12">
      <div className="mix-grid">
        {mixes.map(({ key, name, color, mix }) => <div key={key}>
          <div className="mix-bu" style={{ color }}>{name}</div>
          <Table ariaLabel={`${name} delivery mix for the selected week`}>
            <thead><tr><th className="l">Delivery</th><th>Sites</th><th>Hours</th><th>Labor $</th><th>Vendor cost</th><th>Invoicing</th><th>Cost %</th><th>Margin</th></tr></thead>
            <tbody>
              <tr>
                <td><span className="dtag self">Self-performed</span></td>
                <td>{mix.self.sites || '—'}</td><td>{mix.self.sites ? fmtHours(mix.self.hours) : '—'}</td><td>{mix.self.sites ? <>{fmtMoney(mix.self.labor)}{mix.self.agency > 0 && <span className="tbl-note" title={`incl. ${fmtMoney(mix.self.agency)} agency`}> incl. agency{mix.self.agencyEstimated && <Est label="~" />}</span>}</> : '—'}</td>
                <td>—</td>
                <td>{mix.self.sites ? fmtMoney(mix.self.invoicing) : '—'}</td><td>{pctOrDash(costPctOf(mix.self))}</td><td>{mix.self.sites ? <MarginCell s={mix.self} /> : '—'}</td>
              </tr>
              <tr>
                <td><span className="dtag sub">Subcontracted</span></td>
                <td>{mix.sub.sites || '—'}</td><td>—</td><td>—</td>
                <td>{mix.sub.sites ? <>{fmtMoney(mix.sub.vendor)}{mix.sub.vendorEstimated && <Est label="~" />}</> : '—'}</td>
                <td>{mix.sub.sites ? fmtMoney(mix.sub.invoicing) : '—'}</td><td>{pctOrDash(costPctOf(mix.sub))}</td><td>{mix.sub.sites ? <MarginCell s={mix.sub} /> : '—'}</td>
              </tr>
              <tr className="tot">
                <td>Total</td><td>{mix.total.sites}</td><td>{fmtHours(mix.total.hours)}</td><td>{fmtMoney(mix.total.labor)}</td>
                <td>{mix.total.vendor > 0 ? <>{fmtMoney(mix.total.vendor)}{mix.total.vendorEstimated && <Est label="~" />}</> : '—'}</td>
                <td>{fmtMoney(mix.total.invoicing)}</td><td>{pctOrDash(costPctOf(mix.total))}</td><td><MarginCell s={mix.total} /></td>
              </tr>
            </tbody>
          </Table>
        </div>)}
      </div>
      {delivery !== 'all' && <p className="tbl-note" style={{ marginTop: 8 }}>Showing {delivery === 'subcontracted' ? 'subcontracted' : 'self-performed'} sites only — switch Delivery to “All delivery” for the full mix.</p>}
    </Card>
    {subAccounts && <Card title="By sub-account — selected week" className="mt12">
      <p className="tbl-note" style={{ marginBottom: 8 }}>Click a row to slice the dashboard to that sub-account.</p>
      <Table ariaLabel="Sub-account summary for the selected week">
        <thead><tr><th className="l">Sub-account</th><th>Sites</th><th>Self-performed labor</th><th>Vendor cost</th><th>Total cost</th><th>Invoicing</th><th>Cost %</th><th>Margin</th><th>WoW cost</th></tr></thead>
        <tbody>
          {subRows.map((r) => {
            const s = r.s
            const select = () => onSelectSubAccount?.(r.name)
            return <tr key={r.name} className="row-link" tabIndex={0} role="button" aria-label={`Show ${r.name}`} onClick={select} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select() } }}>
              <td>{r.name}</td>
              {s ? <>
                <td>{s.sites}{s.subSites > 0 && <span className="tbl-note"> ({s.selfSites} self / {s.subSites} sub)</span>}</td>
                <td>{s.selfSites ? <>{fmtMoney(s.labor)}{s.agency > 0 && <span className="tbl-note"> incl. agency{s.agencyEstimated && <Est label="~" />}</span>}</> : '—'}</td>
                <td>{s.vendor > 0 ? <>{fmtMoney(s.vendor)}{s.vendorEstimated && <Est label="~" />}</> : '—'}</td>
                <td><strong>{fmtMoney(s.dollars)}</strong></td>
                <td>{fmtMoney(s.invoicing)}{s.invoicingEstimated && <Est label="~" />}</td>
                <td className={costPctTone(undefined, s) === 'neutral' ? 'neutral' : ''}>{pctOrDash(costPctOf(s))}</td>
                <td><MarginCell s={s} /></td>
                <td>{r.wowCost !== null ? <Wow v={r.wowCost} bad /> : '—'}</td>
              </> : <><td>{'sites' in r && r.sites ? r.sites : '—'}</td><td colSpan={7} className="neutral">{noRowsHint}</td></>}
            </tr>
          })}
          <tr className="tot">
            <td>Total</td><td>{tot.sites}</td><td>{fmtMoney(tot.labor)}</td>
            <td>{tot.vendor > 0 ? <>{fmtMoney(tot.vendor)}{tot.vendorEstimated && <Est label="~" />}</> : '—'}</td>
            <td>{fmtMoney(tot.dollars)}</td><td>{fmtMoney(tot.invoicing)}{anyInvEst && <Est label="~" />}</td>
            <td>{pctOrDash(costPctOf(tot))}</td><td><MarginCell s={tot} /></td>
            <td>{ptot ? <Wow v={pctChange(tot.dollars, ptot)} bad /> : '—'}</td>
          </tr>
        </tbody>
      </Table>
    </Card>}
    <div className="mt12">
      <Card title="QA score vs budget variance — selected week">
        {qa ? <EmptySlot title="QA scores not connected" hint="The API returned a QA payload this build does not render yet." height={240} /> : <EmptySlot title="QA scores not connected" hint="QA site scores are not in the reporting warehouse. This slot keeps the executive layout; it fills in when a QA source is connected." height={240} />}
      </Card>
    </div>
    <Card title="QA scores by site — all weeks (YTD)" className="mt12">
      <EmptySlot title="QA scores not connected" hint="No weekly QA scores are available for any site." height={64} />
    </Card>
  </div>
}

/**
 * "Vendor cost — actual vs projected": bars for the closed months' job-cost subcontract line, a hatched bar for the
 * in-progress month's projection, a line for AP subcontractor invoicing by month (company-wide - WinTeam AP is not
 * job-linked) and the month-to-date AP figure as text.
 */
function VendorCostCard({ vendor }: { vendor: ExecutiveVendorBlock }) {
  const history = [...vendor.history].sort((a, b) => a.month.localeCompare(b.month))
  const inProgress = vendor.month_status === 'in_progress' && !history.some((h) => h.month === vendor.month)
  const months = [...history.map((h) => h.month), ...(inProgress ? [vendor.month] : [])]
  const partial = new Set(inProgress ? [vendor.month] : [])
  const bars: ExecSeries = { id: 'sub', label: 'Job-cost subcontract', values: [...history.map((h) => h.job_cost_sub), ...(inProgress ? [vendor.projected_month_sub] : [])], color: TOTAL_COLOR, kind: 'bar' }
  const ap: ExecSeries = { id: 'ap', label: 'AP subcontractor invoiced (company-wide)', values: [...history.map((h) => h.ap_subcontractor_invoiced), ...(inProgress ? [null] : [])], color: VENDOR_COLOR }
  const legend: LegendItem[] = [{ label: 'Job-cost subcontract (closed month)', color: TOTAL_COLOR, kind: 'bar' }, { label: 'Projected (month in progress)', color: TOTAL_COLOR, kind: 'hatched' }, { label: 'AP subcontractor invoiced — company-wide', color: VENDOR_COLOR }]
  const table: WeeklyTable = {
    columns: [{ key: 'month', header: 'Month', kind: 'text' }, { key: 'sub', header: 'Job-cost subcontract', kind: 'dollars' }, { key: 'ap_sub', header: 'AP subcontractor invoiced (company-wide)', kind: 'dollars' }, { key: 'ap_all', header: 'AP all vendors (company-wide)', kind: 'dollars' }, { key: 'status', header: 'Status', kind: 'text' }],
    rows: [
      ...history.map((h): TableRow => ({ month: monthYear(h.month), sub: h.job_cost_sub, ap_sub: h.ap_subcontractor_invoiced, ap_all: h.ap_all_invoiced, status: 'closed' })),
      ...(inProgress ? [{ month: monthYear(vendor.month), sub: vendor.projected_month_sub, ap_sub: vendor.ap_live?.invoiced_to_date ?? null, ap_all: null, status: `projected (${vendor.projected_basis.replace(/_/g, ' ')}, ${vendor.sites_projected} sites)${vendor.ap_live ? `; AP to date through ${vendor.ap_live.through}` : ''}` } satisfies TableRow] : []),
    ],
  }
  const live = vendor.ap_live
  const extras = (i: number) => {
    const m = months[i]
    if (m === vendor.month && inProgress) return [`Projection: ${vendor.projected_basis.replace(/_/g, ' ')} · ${vendor.sites_projected} sites`, ...(live ? [`AP invoiced to date ${fmtCurrency(live.invoiced_to_date)} (company-wide, through ${fmtDate(live.through)})`] : [])]
    const h = history[i]
    return h ? [`AP all vendors ${fmtCurrency(h.ap_all_invoiced)} (company-wide)`] : []
  }
  const dollarMax = dollarClampMax(bars.values)
  return <ChartCard title="Vendor cost — actual vs projected" className="chart-card--wide" subtitle={`Job-cost subcontract by month for this scope vs AP subcontractor invoicing for the whole company${vendor.as_of ? ` · as of ${fmtDate(vendor.as_of)}` : ''}`} legend={legend} table={table} csvName={csvFileName('vendor-cost-actual-vs-projected', vendor.month)}
    note={<>AP is company-wide because WinTeam AP invoices are not job-linked; the bars are this scope's job-cost subcontract line.{dollarMax !== null && <> A month far above the others is drawn at the top of the axis with a ▲ and its real value in the tooltip.</>}</>}
    chart={(h) => <ExecChart weeks={months} partialWeeks={partial} metric="dollars" dollarMax={dollarMax} series={[bars, ap]} height={h} periodLabel={monthYear} extras={extras} ariaLabel="Vendor cost by month: job-cost subcontract vs AP subcontractor invoicing" />}>
    {live && <p className="chart-text">AP invoiced this month to date <strong>{fmtCurrency(live.invoiced_to_date)}</strong> through {fmtDate(live.through)} · {live.invoices} {live.invoices === 1 ? 'invoice' : 'invoices'} from {live.vendors} {live.vendors === 1 ? 'vendor' : 'vendors'}{live.by_vendor_type.length ? ` (${live.by_vendor_type.map((t) => `${t.vendor_type} ${fmtCurrency(t.invoiced)}`).join(', ')})` : ''} · company-wide. Projected {monthYear(vendor.month)} subcontract cost for this scope: <strong>{fmtCurrency(vendor.projected_month_sub)}</strong>.</p>}
    {!live && inProgress && <p className="chart-text">Projected {monthYear(vendor.month)} subcontract cost for this scope: <strong>{fmtCurrency(vendor.projected_month_sub)}</strong> ({vendor.projected_basis.replace(/_/g, ' ')}, {vendor.sites_projected} sites). No AP invoices for the month yet.</p>}
  </ChartCard>
}
