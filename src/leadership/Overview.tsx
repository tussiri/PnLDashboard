import type { ReactNode } from 'react'
import type { LeadershipAccount, LeadershipRow } from '../services/apiTypes'
import { Badge, ChartCard, Kpi, Swatch, toneOf } from './ui'
import { MixChart, SegmentMeasureChart, useTokens } from './charts'
import { includesVendor, segmentLabel, inSentence, vendorLabel, type DataFlags } from './data'
import { hours, hours1, money, moneyK, pct, pts } from './format'
import { statusOf, type AccountNote, type AccountSummary, type MetricOptions, type Rollup } from './metrics'
import { monthLabel, monthShort } from './routes'

const siteWord = (n: number) => `${n} site${n === 1 ? '' : 's'}`
const SYNC_NAME: Record<string, string> = { winteam_sarus: 'Sarus', nightly: 'Nightly', relay: 'Relay' }

/** Facts that qualify the week's numbers: catch-all and non-billed jobs, estimates, allocation, stale or failed data. */
export function Notes({ summary, account, flags, options, revenueMonth }: { summary: AccountSummary<LeadershipRow>; account: LeadershipAccount; flags: DataFlags; options: MetricOptions; revenueMonth: string | null }) {
  const items: { tone: '' | 'warn' | 'bad'; key: string; label: string; body: ReactNode }[] = []
  const add = (tone: '' | 'warn' | 'bad', key: string, label: string, body: ReactNode) => items.push({ tone, key, label, body })
  const effort = (labor: number, hrs: number, ot: number) => `${money(labor)}, ${hours(hrs)} hrs, ${hours(ot)} OT`
  for (const n of summary.notes as AccountNote[]) {
    if (n.kind === 'catch_all') add('', `c${n.job_number}`, `Job ${n.job_number} catch-all`, `${effort(n.labor, n.hours, n.otHours)}. Sites only ${pct(n.sitesLaborPct)}`)
    if (n.kind === 'non_billed') add('warn', `n${n.job_number}`, `Job ${n.job_number} non-billed`, `${effort(n.labor, n.hours, n.otHours)}. All-in labor % ${pct(n.allInLaborPct)}`)
    if (n.kind === 'billed_no_labor') add('', 'nolab', 'Billed, no cost', `${n.jobs.slice(0, 8).map((j) => `${j.job_number} ${j.site_name}`).join(', ')}${n.jobs.length > 8 ? `, ${n.jobs.length - 8} more` : ''}`)
    if (n.kind === 'budget_unreliable') add('', 'budget', 'Budget hours', `${pct(n.ratio)} of actual; reference only`)
    if (n.kind === 'labor_estimated') add('warn', 'est', 'Labor estimated', `${money(n.labor)} at ${siteWord(n.jobs)}; no pay report`)
    if (n.kind === 'vendor_projected') add('warn', 'vproj', `${vendorLabel(account)} projected`, `${money(n.amount)} at ${siteWord(n.jobs)}; from contract or prior month`)
    if (n.kind === 'revenue_allocated') add('', 'alloc', 'Parent billing spread', `${money(n.amount)} over ${siteWord(n.jobs)} by ${n.weight === 'actual_hours' ? `${monthLabel(revenueMonth)} hours worked` : n.weight === 'week_hours' ? 'week hours' : `${monthLabel(revenueMonth)} budget hours`}`)
  }
  if (flags.revenueLag) add('bad', 'lag', 'Invoicing month', `${monthLabel(flags.revenueLag.revenueMonth)}; ${monthLabel(flags.revenueLag.expectedMonth)} job cost not loaded`)
  for (const s of flags.failedSyncs) add('bad', `s${s.integration}`, `${SYNC_NAME[s.integration] ?? 'WinTeam'} sync failed`, s.at ? s.at.slice(0, 10) : '')
  if (flags.weekInProgress) add('warn', 'prog', 'Week in progress', 'Partial hours and labor')
  add('', 'lp', 'Labor %', includesVendor(account) ? `(Direct labor + ${inSentence(vendorLabel(account))}) ÷ invoicing` : 'Direct labor ÷ invoicing')
  if (options.segmentTargets && Object.keys(options.segmentTargets).length) add('', 'segt', `${segmentLabel(account)} targets`, Object.entries(options.segmentTargets).map(([s, t]) => `${s} ${pct(t)}`).join(', '))
  if (!items.length) return null
  return <dl className="notes">{items.map((i) => <div key={i.key}><dt className={i.tone}>{i.label}</dt><dd>{i.body}</dd></div>)}</dl>
}

function SegmentCard({ name, rollup, target, watchBand, badge, sub, account, priorShort }: { name: string; rollup: Rollup; target: number; watchBand?: number; badge: ReactNode; sub: string; account: LeadershipAccount; priorShort: string }) {
  const status = statusOf(rollup.measurePct, target, watchBand)
  return <div className="card">
    <div className="seg-hdr"><div><div className="seg-name">{name}</div><div className="seg-sub">{sub}</div></div>{badge}</div>
    <div className="kpi4">
      <Kpi small label="Invoicing" value={moneyK(rollup.invoice)} />
      <Kpi small label="Total labor" value={moneyK(rollup.cost)} />
      <Kpi small label="Labor %" value={pct(rollup.measurePct)} tone={toneOf(status)} sub={rollup.priorLaborPct != null ? `${priorShort} ${pct(rollup.priorLaborPct)}` : ''} />
      <Kpi small label="OT %" value={pct(rollup.otPct)} sub={`${hours(rollup.otHours)} OT hrs`} tone={rollup.otPct > 0.15 ? 'bad' : rollup.otPct > 0.1 ? 'warn' : ''} />
    </div>
  </div>
}

export function Overview({ account, rows, summary, options, flags }: { account: LeadershipAccount; rows: LeadershipRow[]; summary: AccountSummary<LeadershipRow>; options: MetricOptions; flags: DataFlags }) {
  const t = useTokens()
  const target = options.target
  const revenueMonth = rows.find((r) => r.revenue_month)?.revenue_month ?? null
  const priorShort = monthShort(revenueMonth)
  const label = segmentLabel(account)
  const withVendor = includesVendor(account)
  const a = summary.account
  const catchAll = summary.catchAll
  const catchJobs = summary.sites.filter((r) => r.role === 'catch_all')
  const nonBilled = summary.sites.filter((r) => r.role === 'non_billed')
  const accountStatus = statusOf(a.measurePct, target, options.watchBand)
  const segs = summary.segments
  const mixLabels = [...segs.map((s) => s.segment), ...catchJobs.map((r) => `Job ${r.job_number} catch-all`), ...nonBilled.map((r) => `Job ${r.job_number} non-billed`)]
  return <>
    <div className="kpi-lg">
      <Kpi label="Invoicing" value={money(summary.all.invoice)} sub={account.revenue_method === 'weekly_billing' ? undefined : `${monthLabel(revenueMonth)} revenue ÷ ${account.revenue_divisor}`} />
      <Kpi label="Total labor" value={money(a.cost)} sub={[withVendor && a.vendor > 0 ? `Incl. ${money(a.vendor)} ${inSentence(vendorLabel(account))}` : null, catchJobs.length ? `incl. ${money(catchAll.cost)} catch-all` : null].filter(Boolean).join('; ') || undefined} />
      <Kpi label="Labor %" value={pct(a.measurePct)} tone={toneOf(accountStatus)} sub={a.measurePct == null ? undefined : `${pts(a.measurePct - target)} vs ${pct(target)} target${catchJobs.length ? `; sites only ${pct(summary.billed.measurePct)}` : ''}`} />
      <Kpi label="OT cost" value={money(a.otDollars)} sub={`${hours(a.otHours)} hrs, ${pct(a.otPct)} of hours`} />
      <Kpi label="Hours" value={hours(a.hours)} />
      <Kpi label="Hours to cut" value={<>{hours1(summary.headerOverHours / 7)}<span className="of">/day</span></>} tone={summary.headerOverHours > 0 ? 'bad' : 'ok'}
        sub={`${hours(summary.headerOverHours)}h this week${catchJobs.length ? `, incl. ${hours(summary.catchAllOverHours)} catch-all` : ''}`} />
    </div>
    <Notes summary={summary} account={account} flags={flags} options={options} revenueMonth={revenueMonth} />
    <div className="seg-grid">
      {segs.map((s) => <SegmentCard key={s.segment} name={s.segment} rollup={s.rollup} target={s.target} watchBand={options.watchBand} account={account} priorShort={priorShort}
        badge={<Badge status={statusOf(s.rollup.measurePct, s.target, options.watchBand)} />} sub={`${siteWord(s.rollup.count)}, ${s.rollup.over} over`} />)}
      {catchJobs.length > 0 && <SegmentCard name="Catch-all" rollup={catchAll} target={target} account={account} priorShort={priorShort} badge={null} sub={catchJobs.map((r) => `Job ${r.job_number}`).join(', ')} />}
      {nonBilled.length > 0 && <SegmentCard name="Non-billed" rollup={summary.nonBilled} target={target} account={account} priorShort={priorShort} badge={null} sub={nonBilled.map((r) => `Job ${r.job_number} ${r.site_name}`).join(', ')} />}
    </div>
    {segs.length > 0 && <div className="charts2">
      <ChartCard title={`Labor % by ${label}`} height={260}
        legend={<><Swatch color={t.ok} label="This week" /><Swatch color={t.muted} label={`${priorShort} actual`} /><Swatch line label={`Target ${pct(target)}`} /></>}
        chart={<SegmentMeasureChart labels={segs.map((s) => s.segment)} week={segs.map((s) => s.rollup.measurePct)} weekTones={segs.map((s) => toneOf(statusOf(s.rollup.measurePct, s.target, options.watchBand)))}
          prior={segs.map((s) => s.rollup.priorLaborPct)} target={target} weekLabel="This week" priorLabel={`${priorShort} actual`} />}
        table={<table><thead><tr><th className="nosort l">{label}</th><th className="nosort">This week</th><th className="nosort">{priorShort} actual</th><th className="nosort">Target</th></tr></thead>
          <tbody>{segs.map((s) => <tr key={s.segment}><td className="l">{s.segment}</td><td>{pct(s.rollup.measurePct)}</td><td>{pct(s.rollup.priorLaborPct)}</td><td>{pct(s.target)}</td></tr>)}</tbody></table>} />
      <ChartCard title={`Invoicing vs total labor by ${label}`} height={260}
        legend={<><Swatch color={t.accent2} label="Invoicing" /><Swatch color={t.accent} label="Total labor" /></>}
        chart={<MixChart labels={mixLabels} invoice={[...segs.map((s) => s.rollup.invoice), ...catchJobs.map(() => 0), ...nonBilled.map(() => 0)]}
          cost={[...segs.map((s) => s.rollup.cost), ...catchJobs.map((r) => r.cost), ...nonBilled.map((r) => r.cost)]} costLabel="Total labor" />}
        table={<table><thead><tr><th className="nosort l">{label}</th><th className="nosort">Invoicing</th><th className="nosort">Total labor</th></tr></thead>
          <tbody>{segs.map((s) => <tr key={s.segment}><td className="l">{s.segment}</td><td>{money(s.rollup.invoice)}</td><td>{money(s.rollup.cost)}</td></tr>)}
            {[...catchJobs, ...nonBilled].map((r) => <tr key={r.job_number}><td className="l">Job {r.job_number}</td><td>{money(0)}</td><td>{money(r.cost)}</td></tr>)}</tbody></table>} />
    </div>}
  </>
}
