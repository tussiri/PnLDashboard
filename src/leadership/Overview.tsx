import { useMemo, type ReactNode } from 'react'
import type { LeadershipAccount, LeadershipMonthlyJob, LeadershipRow } from '../services/apiTypes'
import { Badge, ChartCard, Kpi, Swatch, toneOf, useVocab } from './ui'
import { LaborMixChart, MonthWeekTrendChart, SiteLpChart, useTokens } from './charts'
import { closedMonths, includesVendor, inSentence, monthLaborPct, monthRevenue, rowsOfWeek, segmentLabel, segmentOrder, siteMonths, useMonthly, useRows, vendorLabel, type DataFlags } from './data'
import { hours, hours1, money, moneyK, pct } from './format'
import { accountSummary, statusOf, type AccountNote, type AccountSummary, type MetricOptions, type SiteMetrics } from './metrics'
import { monthLabel, monthShort, weekTick } from './routes'
import { weekChange, wordsFor } from './vocab'

const siteWord = (n: number) => `${n} site${n === 1 ? '' : 's'}`
const SYNC_NAME: Record<string, string> = { winteam_sarus: 'Sarus', nightly: 'Nightly', relay: 'Relay', mail_inbox: 'Records inbox' }

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
  const w = wordsFor(account.vocabulary ?? 'amazon')
  const factor = account.vendor_factor ?? 1
  const vendorPart = includesVendor(account) ? ` + ${inSentence(vendorLabel(account))}${factor < 1 ? ` at ${Math.round(factor * 100)}%` : ''}` : ''
  add('', 'lp', 'Labor %', `(${w.direct} labor${summary.sites.some((r) => (r.pallet_labor ?? 0) > 0) ? ' + pallet' : ''}${vendorPart}) ÷ ${w.invoice.toLowerCase()}`)
  if (options.segmentTargets && Object.keys(options.segmentTargets).length) add('', 'segt', `${segmentLabel(account)} targets`, Object.entries(options.segmentTargets).map(([s, t]) => `${s} ${pct(t)}`).join(', '))
  if (!items.length) return null
  return <dl className="notes">{items.map((i) => <div key={i.key}><dt className={i.tone}>{i.label}</dt><dd>{i.body}</dd></div>)}</dl>
}

type Row = SiteMetrics<LeadershipRow>

export const palletOf = (r: Row) => r.pallet_labor ?? 0
export const directOf = (r: Row) => r.labor - palletOf(r)
/**
 * The week's variable (OS, pallet) invoice, when the Job Cost Analysis carries the revenue split. Only
 * accounts grouped by pallet sites read it: other accounts book ordinary billing to the same OS line
 * (the school districts bill everything there), so the split means nothing for them.
 */
export function variableWk(r: LeadershipRow, o: MetricOptions): number | null {
  if (!o.palletSplit) return null
  const monthly = o.invoiceBasis === 'run_rate_3m' ? r.variable_run_rate : r.revenue_month_variable
  return monthly == null ? null : monthly / (o.divisor ?? 4.33)
}
const short = (name: string) => name.replace(/^[A-Z][A-Za-z]+ ?- ?/, '').replace(', CA 94534', '').replace(' - Cargo Bldg', ' Cargo').replace(/ (Elementary|Middle|High) School$/, ' $1')

/** Monthly jobs in the labor views: sites, their pallet jobs and catch-all jobs (not split-out subcontracted sites). */
export const laborJobs = (account: LeadershipAccount, jobs: LeadershipMonthlyJob[]) =>
  jobs.filter((j) => j.role !== 'non_billed' && !(account.split_subcontracted && j.delivery_model === 'subcontracted'))

/** Every account's overview: headline figures, notes, one card per group, the trend, labor % by site and where the labor dollars went. */
export function Overview({ account, rows, summary, options, flags, headline = true }: { account: LeadershipAccount; rows: LeadershipRow[]; summary: AccountSummary<LeadershipRow>; options: MetricOptions; flags: DataFlags; headline?: boolean }) {
  const t = useTokens()
  const vocab = useVocab()
  const w = wordsFor(vocab)
  const target = options.target
  const factor = options.vendorFactor ?? 1
  const history = useRows(account.slug, 8)
  const monthly = useMonthly(account.slug)
  const revenueMonth = rows.find((r) => r.revenue_month)?.revenue_month ?? null
  const a = summary.account
  const sites = summary.sites.filter((r) => r.role === 'site')
  const billed = sites.filter((r) => r.invoice > 0)
  const unbilled = sites.filter((r) => !(r.invoice > 0) && r.labor > 0)
  const catchJobs = summary.sites.filter((r) => r.role === 'catch_all')
  const nonBilled = summary.sites.filter((r) => r.role === 'non_billed')
  const palD = summary.sites.reduce((x, r) => x + palletOf(r), 0)
  const palHrs = summary.sites.reduce((x, r) => x + (r.pallet_hours ?? 0), 0)
  const variable = sites.some((r) => variableWk(r, options) != null) ? sites.reduce((x, r) => x + (variableWk(r, options) ?? 0), 0) : null
  const unbilledHours = unbilled.reduce((x, r) => x + r.hours + r.otPremiumHours, 0)
  const over = summary.headerOverHours + unbilledHours
  const accountStatus = statusOf(a.measurePct, target, options.watchBand)

  const weeks = useMemo(() => (history.data?.weeks ?? []).map((wk) => {
    const wr = rowsOfWeek(history.data?.rows, wk)
    return { week: wk, s: wr.length ? accountSummary(wr, options, segmentOrder(account)).account : null }
  }), [history.data, options, account])
  const prev = weeks.length > 1 ? weeks[weeks.length - 2].s : null
  const closed = closedMonths(monthly.data)
  const lastClosed = closed.at(-1)
  const scopeJobs = useMemo(() => (monthly.data ? laborJobs(account, monthly.data.jobs) : []), [monthly.data, account])
  const actual = lastClosed ? monthLaborPct(scopeJobs, lastClosed, factor) : null
  const change = (cur: number | null, before: number | null | undefined, format: (v: number) => string) =>
    cur == null || before == null ? null : `${cur - before >= 0 ? '+' : '−'}${format(Math.abs(cur - before))} ${vocab === 'fedex' ? 'vs prior wk' : 'WoW'}`
  const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join('; ')

  const basis = account.revenue_method === 'weekly_billing' ? null : options.invoiceBasis === 'run_rate_3m'
    ? (variable != null ? `Fixed ${moneyK(summary.all.invoice - variable)} + variable ${moneyK(variable)} run rate ÷ ${account.revenue_divisor}` : `3-month run rate ÷ ${account.revenue_divisor}`)
    : `${monthLabel(revenueMonth)} revenue ÷ ${account.revenue_divisor}`
  const laborParts = [palD > 0 ? `${w.direct} ${moneyK(a.labor - palD)} + pallet ${moneyK(palD)}` : null, a.vendor > 0 ? `${inSentence(vendorLabel(account))} ~${moneyK(a.vendor)}` : null,
    catchJobs.length ? `incl. ${moneyK(summary.catchAll.cost)} catch-all` : null].filter(Boolean).join(' + ')

  const groups = summary.segments.map((g) => ({ name: g.segment, list: sites.filter((r) => r.segment === g.segment), target: g.target }))
  const trend = useMemo(() => {
    const out: { label: string; labor: number | null; invoice: number | null; lp: number | null }[] = []
    const div = account.revenue_divisor || 4.33
    for (const m of closed) {
      const inv = scopeJobs.reduce((x, j) => x + monthRevenue(j.months[m]), 0)
      const lab = scopeJobs.reduce((x, j) => x + (j.months[m]?.direct_labor ?? 0) + (j.months[m]?.subcontractors ?? 0) * factor, 0)
      out.push({ label: `${monthShort(m)} actual`, labor: lab / div, invoice: inv / div, lp: inv > 0 ? lab / inv : null })
    }
    for (const x of weeks) out.push({ label: weekTick(x.week), labor: x.s?.cost ?? null, invoice: x.s?.invoice ?? null, lp: x.s?.measurePct ?? null })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closed.join(), scopeJobs, weeks, account, factor])
  const sorted = [...billed].sort((x, y) => (y.measurePct ?? 0) - (x.measurePct ?? 0))
  const mix = [...groups.map((g) => ({ name: g.name, list: g.list })), ...catchJobs.map((r) => ({ name: `Job ${r.job_number} catch-all`, list: [r] })), ...nonBilled.map((r) => ({ name: `Job ${r.job_number} non-billed`, list: [r] }))]
  const sum = (list: Row[], f: (r: Row) => number) => list.reduce((x, r) => x + f(r), 0)
  const groupLp = (list: Row[]) => (monthly.data && lastClosed ? monthLaborPct(list.flatMap((r) => siteMonths(monthly.data!.jobs, r.company, r.kids, r.job_number)), lastClosed, factor) : null)
  const subLabel = w.subCol(vendorLabel(account))

  return <>
    {headline && <div className="kpi-lg">
      <Kpi label={w.invoice} value={money(summary.all.invoice)} sub={basis ?? undefined} />
      <Kpi label={w.labor} value={money(a.cost)} sub={join(laborParts, change(a.cost, prev?.cost, money)) || undefined} />
      <Kpi label={w.accountLaborPct} value={pct(a.measurePct)} tone={toneOf(accountStatus)}
        sub={join(`Target ${pct(target)}`, lastClosed ? `${monthLabel(lastClosed)} actual ${pct(actual)}` : null,
          a.measurePct != null && prev?.measurePct != null ? weekChange(a.measurePct - prev.measurePct, vocab) : null, catchJobs.length ? `sites only ${pct(summary.billed.measurePct)}` : null)} />
      <Kpi label={w.hours} value={hours(a.hours)} sub={join(`${hours(a.otHours)} OT/DT (${pct(a.otPct)})`, palHrs ? `pallet ${hours(palHrs)}` : null, change(a.hours, prev?.hours, hours))} />
      <Kpi label="Margin" value={money(a.margin)} tone={a.margin < 0 ? 'bad' : ''}
        sub={join(pct(a.marginPct), a.allocation > 0 ? `after ${moneyK(a.allocation)} alloc.` : null)} />
      <Kpi label={w.hoursOver} value={hours(over)} tone={over > 0 ? 'bad' : 'ok'}
        sub={join(`${hours1(over / 7)}/day`, w.over(summary.billed.over, billed.length), catchJobs.length ? `${hours(summary.catchAllOverHours)} catch-all` : null, unbilled.length ? `${hours(unbilledHours)} unbilled` : null)} />
    </div>}
    <Notes summary={summary} account={account} flags={flags} options={options} revenueMonth={revenueMonth} />
    <div className="seg-grid">
      {groups.map((g) => {
        const s = accountSummary(g.list, options, []).billed
        const status = statusOf(s.measurePct, g.target, options.watchBand)
        const palG = sum(g.list, palletOf)
        const varG = g.list.some((r) => variableWk(r, options) != null) ? sum(g.list, (r) => variableWk(r, options) ?? 0) : null
        return <GroupCard key={g.name} name={g.name} sub={`${g.list.length} sites, ${s.over} over target`} badge={<Badge status={status} />}
          invoice={s.invoice} invoiceSub={varG != null ? `${moneyK(varG)} variable` : undefined} labor={s.cost} laborSub={palG ? `${moneyK(palG)} pallet` : undefined}
          lp={s.measurePct} lpTone={toneOf(status)} lpSub={lastClosed ? `${monthShort(lastClosed)} ${pct(groupLp(g.list))}` : undefined} otPct={s.otPct} otHours={s.otHours} w={w} />
      })}
      {catchJobs.length > 0 && <GroupCard name="Catch-all" sub={catchJobs.map((r) => `Job ${r.job_number}`).join(', ')} badge={null} invoice={0} labor={summary.catchAll.cost}
        lp={null} lpTone="" otPct={summary.catchAll.otPct} otHours={summary.catchAll.otHours} w={w} />}
      {nonBilled.length > 0 && <GroupCard name="Non-billed" sub={nonBilled.map((r) => `Job ${r.job_number} ${r.site_name}`).join(', ')} badge={null} invoice={0} labor={summary.nonBilled.cost}
        lp={null} lpTone="" otPct={summary.nonBilled.otPct} otHours={summary.nonBilled.otHours} w={w} />}
    </div>
    {trend.length > 1 && <ChartCard title={w.trendTitle} height={260}
      legend={<><Swatch color={t.muted} label="Closed month" /><Swatch color={t.accent2} label="Week" /><Swatch color={t.bad} label="Labor %" /><Swatch line label={`Target ${pct(target)}`} /></>}
      chart={<MonthWeekTrendChart labels={trend.map((x) => x.label)} labor={trend.map((x) => x.labor)} invoice={trend.map((x) => x.invoice)} lp={trend.map((x) => x.lp)} target={target} weekFrom={trend.length - weeks.length} current={trend.length - 1} />}
      table={<table><thead><tr><th className="nosort l">Period</th><th className="nosort">{w.invoiceCol}</th><th className="nosort">{w.laborCol}</th><th className="nosort">Labor %</th></tr></thead>
        <tbody>{trend.map((x) => <tr key={x.label}><td className="l">{x.label}</td><td>{money(x.invoice)}</td><td>{money(x.labor)}</td><td>{pct(x.lp)}</td></tr>)}</tbody></table>} />}
    {billed.length > 0 && <div className="charts2">
      <ChartCard title="Labor % by site this week" height={Math.max(200, sorted.length * 16 + 60)}
        legend={<><Swatch color={t.ok} label={vocab === 'fedex' ? 'On target' : 'On track'} /><Swatch color={t.warn} label="Watch" /><Swatch color={t.bad} label={vocab === 'fedex' ? 'Over' : 'High'} /><Swatch line label={`Target ${pct(target)}`} /></>}
        chart={<SiteLpChart labels={sorted.map((r) => short(r.site_name))} values={sorted.map((r) => r.measurePct)} tones={sorted.map((r) => toneOf(r.status))} target={target}
          details={sorted.map((r) => `${pct(r.measurePct)} (${money(r.cost)} / ${money(r.invoice)})`)} />}
        table={<table><thead><tr><th className="nosort l">Site</th><th className="nosort">Labor %</th><th className="nosort">{w.laborCol}</th><th className="nosort">{w.invoiceCol}</th></tr></thead>
          <tbody>{sorted.map((r) => <tr key={`${r.company}-${r.job_number}`}><td className="l">{r.site_name}</td><td>{pct(r.measurePct)}</td><td>{money(r.cost)}</td><td>{money(r.invoice)}</td></tr>)}</tbody></table>} />
      <ChartCard title="Where the labor dollars went" height={Math.max(180, mix.length * 44 + 40)}
        legend={<><Swatch color={t.accent2} label={w.invoice} /><Swatch color={t.accent} label={`${w.direct} labor`} />{palD > 0 && <Swatch color={t.warn} label="Pallet labor" />}{a.vendor > 0 && <Swatch color={t.muted} label={subLabel} />}</>}
        chart={<LaborMixChart labels={mix.map((x) => x.name)} invoice={mix.map((x) => sum(x.list, (r) => r.invoice))} core={mix.map((x) => sum(x.list, directOf))}
          pallet={mix.map((x) => sum(x.list, palletOf))} sub={mix.map((x) => sum(x.list, (r) => r.vendor))} subLabel={subLabel} directLabel={`${w.direct} labor`} invoiceLabel={w.invoice} />}
        table={<table><thead><tr><th className="nosort l">{segmentLabel(account)}</th><th className="nosort">{w.invoiceCol}</th><th className="nosort">{w.direct}</th><th className="nosort">Pallet</th><th className="nosort">{subLabel}</th></tr></thead>
          <tbody>{mix.map((x) => <tr key={x.name}><td className="l">{x.name}</td><td>{money(sum(x.list, (r) => r.invoice))}</td><td>{money(sum(x.list, directOf))}</td><td>{money(sum(x.list, palletOf))}</td><td>{money(sum(x.list, (r) => r.vendor))}</td></tr>)}</tbody></table>} />
    </div>}
  </>
}

function GroupCard({ name, sub, badge, invoice, invoiceSub, labor, laborSub, lp, lpTone, lpSub, otPct, otHours, w }: {
  name: string; sub: string; badge: ReactNode; invoice: number; invoiceSub?: string; labor: number; laborSub?: string; lp: number | null; lpTone: string; lpSub?: string; otPct: number; otHours: number; w: ReturnType<typeof wordsFor>
}) {
  return <div className="card">
    <div className="seg-hdr"><div><div className="seg-name">{name}</div><div className="seg-sub">{sub}</div></div>{badge}</div>
    <div className="kpi4">
      <Kpi small label={w.invoiceCol} value={moneyK(invoice)} sub={invoiceSub} />
      <Kpi small label={w.labor} value={moneyK(labor)} sub={laborSub} />
      <Kpi small label="Labor %" value={pct(lp)} tone={lpTone} sub={lpSub} />
      <Kpi small label="OT %" value={pct(otPct)} sub={`${hours(otHours)} hrs`} tone={otPct > 0.15 ? 'bad' : otPct > 0.1 ? 'warn' : ''} />
    </div>
  </div>
}
