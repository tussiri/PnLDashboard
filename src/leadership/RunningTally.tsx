import { useMemo, useState } from 'react'
import type { LeadershipAccount } from '../services/apiTypes'
import { RunningTallyChart, useTokens } from './charts'
import { closedMonths, monthRevenue, useMonthly, vendorLabel } from './data'
import { money, moneyK, pct } from './format'
import { monthLabel, monthShort } from './routes'
import { Kpi, Skeleton, Swatch } from './ui'

/** $4.46M above a million, else $812.5K. */
const compact = (v: number) => `${v < 0 ? '−' : ''}${Math.abs(v) >= 1_000_000 ? `$${(Math.abs(v) / 1_000_000).toFixed(2)}M` : moneyK(Math.abs(v))}`

/** Months loaded for the tally: enough to reach January from any month of the year. */
const TALLY_MONTHS = 12

export interface TallyMonth { month: string; revenue: number; labor: number; sub: number }

/**
 * The account's closed months of the latest year, each job's billing (Relay AR for a subcontracted site),
 * job cost direct labor and vendor cost (Relay AP for a subcontracted site, else job cost subcontractors).
 */
export function tallyMonths(data: Parameters<typeof closedMonths>[0]): TallyMonth[] {
  const closed = closedMonths(data)
  const year = closed.at(-1)?.slice(0, 4)
  if (!data || !year) return []
  return closed.filter((m) => m.startsWith(year)).map((month) => {
    let revenue = 0, labor = 0, sub = 0
    for (const j of data.jobs) {
      const x = j.months[month]
      if (!x) continue
      const subcontracted = j.delivery_model === 'subcontracted'
      revenue += monthRevenue(x, subcontracted)
      labor += x.direct_labor
      sub += subcontracted && x.relay_ap > 0 ? x.relay_ap : x.subcontractors
    }
    return { month, revenue, labor, sub }
  })
}

/** Running totals of a list of months. */
export function cumulative(months: TallyMonth[]): TallyMonth[] {
  const run = { revenue: 0, labor: 0, sub: 0 }
  return months.map((m) => {
    run.revenue += m.revenue; run.labor += m.labor; run.sub += m.sub
    return { month: m.month, ...run }
  })
}

/** The account's year to date, month by month: revenue against labor and vendor spend. */
export function RunningTally({ account }: { account: LeadershipAccount }) {
  const t = useTokens()
  const [asTable, setAsTable] = useState(false)
  const q = useMonthly(account.slug, TALLY_MONTHS)
  const months = useMemo(() => tallyMonths(q.data), [q.data])
  const run = useMemo(() => cumulative(months), [months])
  if (!q.data) return q.error ? null : <Skeleton height={300} />
  const total = run.at(-1)
  if (!total) return null
  const sub = vendorLabel(account)
  const year = total.month.slice(0, 4)
  const span = `${monthShort(months[0].month)}–${monthShort(total.month)} ${year}, closed months`
  const margin = total.revenue - total.labor - total.sub
  return <div className="card">
    <div className="ct"><span>Running tally, {year}</span><span className="ctrl"><button type="button" className="linkbtn" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>{asTable ? 'Chart' : 'Table'}</button></span></div>
    <div className="kpi4 tally">
      <Kpi small label="Revenue YTD" value={compact(total.revenue)} tip={`${money(total.revenue)}, ${span}`} />
      <Kpi small label="Labor YTD" value={compact(total.labor)} tip={`${money(total.labor)} job cost direct labor, ${span}`} />
      <Kpi small label="Labor % YTD" value={pct(total.revenue > 0 ? total.labor / total.revenue : null)} tip="Direct labor ÷ revenue" />
      {total.sub > 0 && <Kpi small label={`${sub} YTD`} value={compact(total.sub)} tip={`${money(total.sub)}, ${span}`} />}
      <Kpi small label={total.sub > 0 ? `After labor and ${sub.toLowerCase()}` : 'After labor'} value={compact(margin)} tone={margin < 0 ? 'bad' : ''}
        tip={`${money(margin)}; ${pct(total.revenue > 0 ? margin / total.revenue : null)} of revenue`} />
    </div>
    {asTable
      ? <div className="tw"><table><thead><tr><th className="nosort l">Month</th><th className="nosort">Revenue</th><th className="nosort">Labor</th>{total.sub > 0 && <th className="nosort">{sub}</th>}<th className="nosort">Revenue YTD</th><th className="nosort">Labor YTD</th>{total.sub > 0 && <th className="nosort">{sub} YTD</th>}<th className="nosort">Labor % YTD</th></tr></thead>
        <tbody>{months.map((m, i) => <tr key={m.month}><td className="l">{monthLabel(m.month)}</td><td>{money(m.revenue)}</td><td>{money(m.labor)}</td>{total.sub > 0 && <td>{money(m.sub)}</td>}
          <td>{money(run[i].revenue)}</td><td>{money(run[i].labor)}</td>{total.sub > 0 && <td>{money(run[i].sub)}</td>}<td>{pct(run[i].revenue > 0 ? run[i].labor / run[i].revenue : null)}</td></tr>)}</tbody></table></div>
      : <>
        <div className="legend"><Swatch color={t.accent} label="Revenue" /><Swatch color={t.bad} label="Labor" />{total.sub > 0 && <Swatch color={t.warn} label={`Labor + ${sub.toLowerCase()}`} />}</div>
        <div className="cw" style={{ height: 240 }}>
          <RunningTallyChart labels={run.map((m) => monthShort(m.month))} revenue={run.map((m) => m.revenue)} labor={run.map((m) => m.labor)} sub={run.map((m) => m.sub)} subLabel={sub} />
        </div>
      </>}
  </div>
}
