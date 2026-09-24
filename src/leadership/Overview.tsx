import type { ReactNode } from 'react'
import type { LeadershipAccount, LeadershipRow } from '../services/apiTypes'
import { Badge, ChartCard, Kpi, Swatch, toneOf } from './ui'
import { MixChart, SegmentMeasureChart, useTokens } from './charts'
import { costLabel, measureLabel, type DataFlags } from './data'
import { hours, money, moneyK, pct } from './format'
import { statusOf, type AccountNote, type AccountSummary, type MetricOptions, type Rollup } from './metrics'
import { monthLabel, monthShort } from './routes'

const siteWord = (n: number) => `${n} site${n === 1 ? '' : 's'}`

/** The reference's notes panel, generalized: catch-all, non-billed, billed without labor, budget reliability, estimates, allocation, data freshness. */
export function Notes({ summary, account, flags, options, revenueMonth }: { summary: AccountSummary<LeadershipRow>; account: LeadershipAccount; flags: DataFlags; options: MetricOptions; revenueMonth: string | null }) {
  const m = measureLabel(account).toLowerCase()
  const items: { tone: 'info' | 'warn' | 'bad'; key: string; body: ReactNode }[] = []
  for (const n of summary.notes as AccountNote[]) {
    if (n.kind === 'catch_all') items.push({ tone: 'info', key: `c${n.job_number}`, body: <><b>Job {n.job_number} catch-all:</b> {money(n.labor)}, {hours(n.hours)} hrs ({hours(n.otHours)} OT). In the header, not in segment or site {m}. Account {m} {pct(n.accountLaborPct)}; sites only {pct(n.sitesLaborPct)}.</> })
    if (n.kind === 'non_billed') items.push({ tone: 'warn', key: `n${n.job_number}`, body: <><b>Job {n.job_number} non-billed:</b> {money(n.labor)}, {hours(n.hours)} hrs ({hours(n.otHours)} OT). Outside the header. All-in {m} {pct(n.allInLaborPct)}.</> })
    if (n.kind === 'billed_no_labor') items.push({ tone: 'info', key: 'nolab', body: <><b>Billed, no labor this week:</b> {n.jobs.map((j) => `${j.job_number} ${j.site_name}`).join(', ')}. Invoice included in totals.</> })
    if (n.kind === 'budget_unreliable') items.push({ tone: 'info', key: 'budget', body: <><b>WinTeam budget hours {pct(n.ratio)} of actual hours:</b> reference only. Over target is measured against the target {m}, not budget.</> })
    if (n.kind === 'labor_estimated') items.push({ tone: 'warn', key: 'est', body: <><b>Labor estimated at {siteWord(n.jobs)}:</b> {money(n.labor)} priced at trailing job rates. No pay report covers this week.</> })
    if (n.kind === 'revenue_allocated') items.push({ tone: 'info', key: 'alloc', body: <><b>Parent-billed revenue allocated:</b> {money(n.amount)} spread over {siteWord(n.jobs)} by {monthLabel(revenueMonth)} budget hours.</> })
  }
  if (flags.revenueLag) items.push({ tone: 'bad', key: 'lag', body: <><b>Invoice based on {monthLabel(flags.revenueLag.revenueMonth)} revenue:</b> {monthLabel(flags.revenueLag.expectedMonth)} job cost not loaded.</> })
  for (const s of flags.failedSyncs) items.push({ tone: 'bad', key: `s${s.integration}`, body: <><b>Last {s.integration === 'winteam_sarus' ? 'Sarus sync' : s.integration === 'nightly' ? 'nightly sync' : 'WinTeam sync'} failed</b>{s.at ? ` ${s.at.slice(0, 10)}` : ''}. Figures may be incomplete.</> })
  if (flags.weekInProgress) items.push({ tone: 'warn', key: 'prog', body: <><b>Week in progress:</b> partial hours and labor.</> })
  if (account.cost_basis === 'labor_plus_vendor') items.push({ tone: 'info', key: 'cost', body: <><b>Cost % = (labor + vendor) ÷ weekly invoice.</b> Vendor cost {money(summary.all.vendor)} this week.</> })
  if (options.segmentTargets && Object.keys(options.segmentTargets).length) items.push({ tone: 'info', key: 'segt', body: <><b>Segment targets:</b> {Object.entries(options.segmentTargets).map(([s, t]) => `${s} ${pct(t)}`).join(', ')}.</> })
  if (!items.length) return null
  return <div className="notes">{items.map((i) => <div key={i.key} className={`note ${i.tone === 'warn' ? '' : i.tone}`}>{i.body}</div>)}</div>
}

function SegmentCard({ name, rollup, target, watchBand, badge, sub, account, priorShort }: { name: string; rollup: Rollup; target: number; watchBand?: number; badge: ReactNode; sub: string; account: LeadershipAccount; priorShort: string }) {
  const status = statusOf(rollup.measurePct, target, watchBand)
  return <div className="card">
    <div className="seg-hdr"><div><div className="seg-name">{name}</div><div className="seg-sub">{sub}</div></div>{badge}</div>
    <div className="kpi4">
      <Kpi small label="Invoice" value={moneyK(rollup.invoice)} />
      <Kpi small label={account.cost_basis === 'labor_plus_vendor' ? 'Cost' : 'Labor'} value={moneyK(rollup.cost)} />
      <Kpi small label={measureLabel(account)} value={pct(rollup.measurePct)} tone={toneOf(status)} sub={rollup.priorLaborPct != null ? `${priorShort} ${pct(rollup.priorLaborPct)}` : ''} />
      <Kpi small label="OT %" value={pct(rollup.otPct)} sub={`${hours(rollup.otHours)} hrs`} tone={rollup.otPct > 0.15 ? 'bad' : rollup.otPct > 0.1 ? 'warn' : ''} />
    </div>
  </div>
}

export function Overview({ account, rows, summary, options, flags }: { account: LeadershipAccount; rows: LeadershipRow[]; summary: AccountSummary<LeadershipRow>; options: MetricOptions; flags: DataFlags }) {
  const t = useTokens()
  const target = options.target
  const revenueMonth = rows.find((r) => r.revenue_month)?.revenue_month ?? null
  const priorShort = monthShort(revenueMonth)
  const measure = measureLabel(account)
  const a = summary.account
  const catchAll = summary.catchAll
  const catchJobs = summary.sites.filter((r) => r.role === 'catch_all')
  const nonBilled = summary.sites.filter((r) => r.role === 'non_billed')
  const accountStatus = statusOf(a.measurePct, target, options.watchBand)
  const segs = summary.segments
  const mixLabels = [...segs.map((s) => s.segment), ...catchJobs.map((r) => `Job ${r.job_number} catch-all`), ...nonBilled.map((r) => `Job ${r.job_number} non-billed`)]
  return <>
    <div className="kpi-lg">
      <Kpi label="Weekly invoice" value={money(summary.all.invoice)} sub={account.revenue_method === 'weekly_billing' ? 'Billing for the week' : `${monthLabel(revenueMonth)} revenue ÷ ${account.revenue_divisor}`} />
      <Kpi label={account.cost_basis === 'labor_plus_vendor' ? 'Account cost' : 'Account labor'} value={money(a.cost)} sub={catchJobs.length ? `Incl. ${money(catchAll.cost)} catch-all` : account.cost_basis === 'labor_plus_vendor' ? `Labor ${money(a.labor)}, vendor ${money(a.vendor)}` : `${siteWord(summary.billed.count)}`} />
      <Kpi label={`Account ${measure.toLowerCase()}`} value={pct(a.measurePct)} tone={toneOf(accountStatus)} sub={`Target ${pct(target)}${catchJobs.length ? `; sites only ${pct(summary.billed.measurePct)}` : ''}`} />
      <Kpi label="Hours worked" value={hours(a.hours)} sub={`${hours(a.otHours)} OT (${pct(a.otPct)})`} />
      <Kpi label="Hours over target" value={hours(summary.headerOverHours)} tone={summary.headerOverHours > 0 ? 'bad' : 'ok'}
        sub={`${hours(summary.billed.overHours)} at ${summary.billed.over} sites${catchJobs.length ? ` + ${hours(summary.catchAllOverHours)} catch-all` : ''}`} />
    </div>
    <Notes summary={summary} account={account} flags={flags} options={options} revenueMonth={revenueMonth} />
    <div className="seg-grid">
      {segs.map((s) => <SegmentCard key={s.segment} name={s.segment} rollup={s.rollup} target={s.target} watchBand={options.watchBand} account={account} priorShort={priorShort}
        badge={<Badge status={statusOf(s.rollup.measurePct, s.target, options.watchBand)} />} sub={`${siteWord(s.rollup.count)}, ${s.rollup.over} over target`} />)}
      {catchJobs.length > 0 && <SegmentCard name="Catch-all" rollup={catchAll} target={target} account={account} priorShort={priorShort} badge={<Badge status="none" label="In header" />} sub={`${catchJobs.map((r) => `Job ${r.job_number}`).join(', ')}, not recorded at a site`} />}
      {nonBilled.length > 0 && <SegmentCard name="Non-billed" rollup={summary.nonBilled} target={target} account={account} priorShort={priorShort} badge={<Badge status="none" label="No billing" />} sub={nonBilled.map((r) => `Job ${r.job_number} ${r.site_name}`).join(', ')} />}
    </div>
    {segs.length > 0 && <div className="charts2">
      <ChartCard title={`${measure} by segment: this week vs ${monthLabel(revenueMonth)} actual`} height={260}
        legend={<><Swatch color={t.ok} label="This week (status color)" /><Swatch color={t.muted} label={`${priorShort} actual incl. sub`} /><Swatch line label={`Target ${pct(target)}`} /></>}
        chart={<SegmentMeasureChart labels={segs.map((s) => s.segment)} week={segs.map((s) => s.rollup.measurePct)} weekTones={segs.map((s) => toneOf(statusOf(s.rollup.measurePct, s.target, options.watchBand)))}
          prior={segs.map((s) => s.rollup.priorLaborPct)} target={target} weekLabel="This week" priorLabel={`${priorShort} actual incl. sub`} />}
        table={<table><thead><tr><th className="nosort l">Segment</th><th className="nosort">This week</th><th className="nosort">{priorShort} actual</th><th className="nosort">Target</th></tr></thead>
          <tbody>{segs.map((s) => <tr key={s.segment}><td className="l">{s.segment}</td><td>{pct(s.rollup.measurePct)}</td><td>{pct(s.rollup.priorLaborPct)}</td><td>{pct(s.target)}</td></tr>)}</tbody></table>} />
      <ChartCard title="Where the dollars went" height={260}
        legend={<><Swatch color={t.accent2} label="Weekly invoice" /><Swatch color={t.accent} label={costLabel(account)} /></>}
        chart={<MixChart labels={mixLabels} invoice={[...segs.map((s) => s.rollup.invoice), ...catchJobs.map(() => 0), ...nonBilled.map(() => 0)]}
          cost={[...segs.map((s) => s.rollup.cost), ...catchJobs.map((r) => r.cost), ...nonBilled.map((r) => r.cost)]} costLabel={costLabel(account)} />}
        table={<table><thead><tr><th className="nosort l">Group</th><th className="nosort">Invoice</th><th className="nosort">{costLabel(account)}</th></tr></thead>
          <tbody>{segs.map((s) => <tr key={s.segment}><td className="l">{s.segment}</td><td>{money(s.rollup.invoice)}</td><td>{money(s.rollup.cost)}</td></tr>)}
            {[...catchJobs, ...nonBilled].map((r) => <tr key={r.job_number}><td className="l">Job {r.job_number}</td><td>{money(0)}</td><td>{money(r.cost)}</td></tr>)}</tbody></table>} />
    </div>}
  </>
}
