import type { LeadershipAccount, LeadershipRow } from '../../services/apiTypes'
import { OverTargetChart, useTokens } from '../charts'
import { segmentLabel, vendorLabel } from '../data'
import { hours, hours1, money, pct, rate } from '../format'
import type { AccountSummary, SiteMetrics } from '../metrics'
import { monthShort } from '../routes'
import { useLeadership } from '../state'
import { ChartCard, Empty, Kpi, SortTable, Swatch, toneOf, type Column } from '../ui'

type Row = SiteMetrics<LeadershipRow>

const short = (name: string) => name.replace(/^[A-Z][A-Za-z]+ ?- ?/, '').replace(', CA 94534', '').replace(' - Cargo Bldg', ' Cargo').replace(/ (Elementary|Middle|High) School$/, ' $1')

/**
 * The FedEx report's Over Target tab, for every account: where the hours over target come from (OT premium,
 * vendor cost, extra hours), a stacked bar per site over target and the sortable site table.
 */
export function OverTarget({ account, summary }: { account: LeadershipAccount; summary: AccountSummary<LeadershipRow> }) {
  const t = useTokens()
  const { navigate } = useLeadership()
  const o = summary.overTarget
  const s = o.rollup
  const sub = vendorLabel(account)
  const target = summary.sites.find((r) => r.role === 'site')?.target
  // Labor with no billing to measure it against: catch-all jobs and billed sites without invoicing, in full.
  const unbilled = summary.sites.filter((r) => r.role === 'catch_all' || (r.role === 'site' && !(r.invoice > 0) && r.labor > 0))
  const unbilledHours = unbilled.reduce((x, r) => x + r.hours + r.otPremiumHours, 0)
  const share = (h: number) => `${pct(s.overHours ? h / s.overHours : 0)} of the overage`
  const top = [...o.rows].sort((a, b) => b.overHours - a.overHours)
  const anySub = o.rows.some((r) => r.overFromSub > 0.05)
  const priorMonth = monthShort(summary.sites.find((r) => r.revenue_month)?.revenue_month ?? null)
  const open = (r: Row) => navigate({ site: { company: r.company ?? '', job: r.job_number } })
  const maxOver = Math.max(1, ...o.rows.map((r) => r.overHours))
  const cols: Column<Row>[] = [
    { key: 'job', header: 'Job', left: true, value: (r) => r.job_number },
    { key: 'name', header: 'Site', left: true, value: (r) => r.site_name, className: 'nm' },
    { key: 'seg', header: segmentLabel(account), left: true, value: (r) => r.segment ?? '', render: (r) => <span className="neutral">{r.segment ?? '–'}</span> },
    { key: 'lp', header: 'Labor %', value: (r) => r.measurePct, render: (r) => <span className={toneOf(r.status)}>{pct(r.measurePct)}</span> },
    { key: 'prior', header: `${priorMonth || 'Prior'} LP`, value: (r) => r.priorLaborPct, render: (r) => <span className="neutral">{pct(r.priorLaborPct)}</span> },
    { key: 'od', header: '$ over', value: (r) => r.overDollars, render: (r) => money(r.overDollars) },
    { key: 'oh', header: 'Hrs over', value: (r) => r.overHours, csv: (r) => r.overHours.toFixed(1),
      render: (r) => <><b>{hours1(r.overHours)}</b><span className="bar" style={{ width: `${Math.max(2, (r.overHours / maxOver) * 80)}px` }} aria-hidden="true" /></> },
    { key: 'op', header: 'OT premium hrs', value: (r) => r.overFromOtPremium, render: (r) => hours1(r.overFromOtPremium) },
    ...(anySub ? [{ key: 'sb', header: `${sub} ~hrs`, value: (r: Row) => r.overFromSub, render: (r: Row) => (r.overFromSub > 0.05 ? hours1(r.overFromSub) : '–') }] : []),
    { key: 'ex', header: 'Extra hrs', value: (r) => r.overFromExtraHours, render: (r) => hours1(r.overFromExtraHours) },
    { key: 'br', header: 'Base rate', value: (r) => r.baseRate, render: (r) => rate(r.baseRate) },
  ]
  return <>
    <div className="kpi-lg">
      <Kpi label="Sites over target" value={<>{o.rows.length}<span className="of"> of {o.billedCount}</span></>} tone={o.rows.length ? 'bad' : 'ok'} tip="Billed sites more than half an hour over target" />
      <Kpi label="Hours over target" value={hours(s.overHours)} tone={s.overHours > 0 ? 'bad' : 'ok'} tip="Base-rate equivalent hours: $ over target ÷ each site's base rate" />
      <Kpi label="Dollars over target" value={money(s.overDollars)} tone={s.overDollars > 0 ? 'bad' : 'ok'} tip={target != null ? `Labor above ${pct(target)} of invoicing` : undefined} />
      <Kpi label="From OT premium" value={hours(o.fromOtPremium)} sub={share(o.fromOtPremium)} tone={o.fromOtPremium > 0 ? 'warn' : ''} tip="Half-time premium on OT hours (full time on double time), capped at each site's hours over" />
      {anySub && <Kpi label={`From ${sub.toLowerCase()} (est.)`} value={hours(o.fromSub)} sub={share(o.fromSub)} tone="warn" tip={`${sub} cost ÷ base rate, after the OT premium`} />}
      <Kpi label="From extra hours" value={hours(o.fromExtraHours)} sub={share(o.fromExtraHours)} tip="Hours worked beyond what billing supports" />
      {unbilledHours > 0 && <Kpi label="No billing" value={hours(unbilledHours)} tone="warn" tip={`Labor with no invoicing, not ranked below: ${unbilled.map((r) => `${r.job_number} ${r.site_name}`).join(', ')}`} />}
    </div>
    {top.length ? <>
      <ChartCard title="Hours over target by site" height={Math.max(140, top.length * 26 + 60)}
        legend={<><Swatch color={t.warn} label="OT premium" />{anySub && <Swatch color={t.accent2} label={sub} />}<Swatch color={t.bad} label="Extra hours" /></>}
        chart={<OverTargetChart labels={top.map((r) => short(r.site_name))} premium={top.map((r) => r.overFromOtPremium)} sub={top.map((r) => r.overFromSub)} extra={top.map((r) => r.overFromExtraHours)} subLabel={sub} />}
        table={<table><thead><tr><th className="nosort l">Site</th><th className="nosort">OT premium</th>{anySub && <th className="nosort">{sub}</th>}<th className="nosort">Extra</th><th className="nosort">Hrs over</th></tr></thead>
          <tbody>{top.map((r) => <tr key={`${r.company}-${r.job_number}`}><td className="l">{r.site_name}</td><td>{hours1(r.overFromOtPremium)}</td>{anySub && <td>{hours1(r.overFromSub)}</td>}<td>{hours1(r.overFromExtraHours)}</td><td>{hours1(r.overHours)}</td></tr>)}</tbody></table>} />
      <div className="card"><SortTable caption="Sites over target" rows={o.rows} columns={cols} defaultSort={{ key: 'oh', dir: -1 }} onRowClick={open} rowLabel={(r) => `Open ${r.site_name}`} csvName={`${account.slug}-over-target`} /></div>
    </> : <Empty>Every billed site is within target this week.</Empty>}
  </>
}
