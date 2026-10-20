import { useMemo, useState } from 'react'
import { useApiQuery } from '../hooks/useApiQuery'
import type { CompanyPnlResponse, PnlGroup, PnlMonth } from '../services/apiTypes'
import { queryKey } from '../services/queryClient'
import { money, pct } from './format'
import { monthLabel, monthShort } from './routes'
import { useLeadership } from './state'
import { Kpi, LoadError, Skeleton, SortTable, type Column } from './ui'

const MONTHS = 7
const ratio = (a: number, b: number) => (b ? a / b : null)
const signed = (v: number) => <span className={v < 0 ? 'bad' : ''}>{money(v)}</span>
const SOURCE: Record<PnlMonth['source'], string> = {
  income_statement: 'Income statement by job',
  mixed: 'Income statement by job for some companies; Job Cost for the rest',
  job_cost: 'Job Cost export; payroll taxes estimated from the burden rate',
}

interface AccountLine { group: string; account: string; name: string; revenue: number; before_overhead: number; overhead: number; after_overhead: number }

/**
 * The company P&L the way finance builds it (GET /leadership/company-pnl): every job's revenue and costs,
 * grouped, corporate overhead charged out by the configured rule, and net profit. Detail sits in hover hints.
 */
export function CompanyPnl() {
  const { api, keyPrefix, decision } = useLeadership()
  const q = useApiQuery<CompanyPnlResponse>(decision ? queryKey(`${keyPrefix}/leadership/company-pnl`, { months: MONTHS }) : null,
    (signal) => api.companyPnl(MONTHS, signal), [api])
  const months = q.data?.months ?? []
  const [picked, setPicked] = useState<string | null>(null)
  const m = months.find((x) => x.month === picked) ?? months.at(-1)
  const prev = m ? months[months.indexOf(m) - 1] : undefined
  const names = q.data?.account_names ?? {}
  const accounts: AccountLine[] = useMemo(() => (m ? m.groups.flatMap((g) => g.accounts.map((a) => ({
    group: g.name, account: a.account, name: a.account === 'other' ? `Other ${g.name}` : names[a.account] ?? a.account,
    revenue: a.revenue, before_overhead: a.before_overhead, overhead: a.overhead, after_overhead: a.after_overhead,
  }))) : []), [m, names])
  if (q.error) return <LoadError error={q.error} onRetry={q.refetch} />
  if (!q.data) return <Skeleton height={320} />
  if (!m) return null

  const toDate = months.filter((x) => x.month.slice(0, 4) === m.month.slice(0, 4) && x.month <= m.month).reduce((a, x) => a + x.net_profit, 0)
  const change = (cur: number, before: number | undefined) => (before == null ? undefined : `${cur - before >= 0 ? '+' : '−'}${money(Math.abs(cur - before))} vs ${monthShort(prev!.month)}`)
  const groupCols: Column<PnlGroup>[] = [
    { key: 'name', header: 'Group', left: true, value: (g) => g.name, className: 'nm' },
    { key: 'rev', header: 'Revenue', value: (g) => g.revenue, render: (g) => money(g.revenue) },
    { key: 'gp', header: 'Gross profit', value: (g) => g.gross_profit, render: (g) => signed(g.gross_profit) },
    { key: 'bef', header: 'Before overhead', value: (g) => g.before_overhead, render: (g) => signed(g.before_overhead) },
    { key: 'bm', header: 'Margin', value: (g) => ratio(g.before_overhead, g.revenue), render: (g) => pct(ratio(g.before_overhead, g.revenue)) },
    { key: 'oh', header: 'Overhead', value: (g) => g.overhead,
      render: (g) => <span title={`Fixed ${money(g.fixed_charge)} + account staff ${money(g.direct_staff)} + pool share ${money(g.pool_share)}`}>{money(g.overhead)}</span> },
    { key: 'ohp', header: 'OH %', value: (g) => ratio(g.overhead, g.revenue), render: (g) => pct(ratio(g.overhead, g.revenue)) },
    { key: 'aft', header: 'After overhead', value: (g) => g.after_overhead, render: (g) => signed(g.after_overhead) },
    { key: 'am', header: 'Net margin', value: (g) => ratio(g.after_overhead, g.revenue), render: (g) => pct(ratio(g.after_overhead, g.revenue)) },
  ]
  const accountCols: Column<AccountLine>[] = [
    { key: 'name', header: 'Customer', left: true, value: (a) => a.name, className: 'nm' },
    { key: 'group', header: 'Group', left: true, value: (a) => a.group },
    { key: 'rev', header: 'Revenue', value: (a) => a.revenue, render: (a) => money(a.revenue) },
    { key: 'bef', header: 'Before overhead', value: (a) => a.before_overhead, render: (a) => signed(a.before_overhead) },
    { key: 'oh', header: 'Overhead', value: (a) => a.overhead, render: (a) => money(a.overhead) },
    { key: 'aft', header: 'After overhead', value: (a) => a.after_overhead, render: (a) => signed(a.after_overhead) },
    { key: 'am', header: 'Net margin', value: (a) => ratio(a.after_overhead, a.revenue), render: (a) => pct(ratio(a.after_overhead, a.revenue)) },
  ]
  const monthCols: Column<PnlMonth>[] = [
    { key: 'month', header: 'Month', left: true, value: (x) => x.month, render: (x) => <span title={SOURCE[x.source]}>{monthLabel(x.month)}{x.source === 'income_statement' ? '' : ' *'}</span> },
    { key: 'rev', header: 'Revenue', value: (x) => x.revenue, render: (x) => money(x.revenue) },
    { key: 'gp', header: 'Gross profit', value: (x) => x.gross_profit, render: (x) => signed(x.gross_profit) },
    { key: 'bef', header: 'Before overhead', value: (x) => x.before_overhead, render: (x) => signed(x.before_overhead) },
    { key: 'oh', header: 'Overhead', value: (x) => x.overhead, render: (x) => money(x.overhead) },
    { key: 'net', header: 'Net profit', value: (x) => x.net_profit, render: (x) => signed(x.net_profit) },
    { key: 'nm', header: 'Net margin', value: (x) => ratio(x.net_profit, x.revenue), render: (x) => pct(ratio(x.net_profit, x.revenue)) },
    { key: 'adj', header: 'Accruals', value: (x) => x.adjustments.accruals,
      render: (x) => (x.adjustments.count ? <span title={`${x.adjustments.count} active adjustments; ${money(x.adjustments.reclasses)} reclassed`}>{money(x.adjustments.accruals)}</span> : '–') },
  ]
  const lineHint = `Labor ${money(m.lines.labor)}, payroll taxes ${money(m.lines.payroll_taxes)}${m.payroll_taxes_basis === 'estimate' ? ' (estimated)' : ''}, subcontractors ${money(m.lines.subcontractors)}, supplies ${money(m.lines.supplies)}, other direct ${money(m.lines.other_direct)}`
  return <>
    <div className="sect-row">
      <h2 className="sect-h" title={SOURCE[m.source]}>Company P&amp;L{m.source === 'income_statement' ? '' : ' *'}</h2>
      <label className="sr-only" htmlFor="pnl-month">Month</label>
      <select id="pnl-month" value={m.month} onChange={(e) => setPicked(e.target.value)}>
        {[...months].reverse().map((x) => <option key={x.month} value={x.month}>{monthLabel(x.month)}</option>)}
      </select>
    </div>
    <div className="kpi-lg">
      <Kpi label="Revenue" value={money(m.revenue)} sub={change(m.revenue, prev?.revenue)} />
      <Kpi label="Gross profit" value={money(m.gross_profit)} tone={m.gross_profit < 0 ? 'bad' : ''} sub={`${pct(ratio(m.gross_profit, m.revenue))} margin`} hint={lineHint} />
      <Kpi label="Corporate overhead" value={money(m.overhead)} sub={`${pct(ratio(m.overhead, m.operating_revenue))} of revenue`}
        hint={`Net cost of the overhead jobs (${m.overhead_jobs.jobs}): ${money(m.overhead_jobs.cost)} cost less ${money(m.overhead_jobs.revenue)} revenue. Pool after fixed charges and account staff: ${money(m.pool)}`} />
      <Kpi label="Net profit" value={money(m.net_profit)} tone={m.net_profit < 0 ? 'bad' : ''} sub={`${pct(ratio(m.net_profit, m.revenue))} margin`}
        hint={m.adjustments.count ? `Includes ${m.adjustments.count} adjustments: ${money(m.adjustments.accruals)} accrued, ${money(m.adjustments.reclasses)} reclassed` : undefined} />
      <Kpi label={`Net profit ${m.month.slice(0, 4)} to date`} value={money(toDate)} tone={toDate < 0 ? 'bad' : ''} hint={`The months shown through ${monthLabel(m.month)}`} />
    </div>
    <div className="card"><div className="ct"><span>By group</span></div>
      <SortTable caption="Company P&L by group" rows={m.groups} columns={groupCols} defaultSort={{ key: 'rev', dir: -1 }} csvName={`company-pnl-groups-${m.month.slice(0, 7)}`} />
    </div>
    <div className="card"><div className="ct"><span>By customer</span></div>
      <SortTable caption="Company P&L by customer" rows={accounts} columns={accountCols} defaultSort={{ key: 'rev', dir: -1 }} csvName={`company-pnl-customers-${m.month.slice(0, 7)}`} pageSize={15} />
    </div>
    <div className="card"><div className="ct"><span>By month</span></div>
      <SortTable caption="Company P&L by month" rows={months} columns={monthCols} defaultSort={{ key: 'month', dir: -1 }} csvName="company-pnl-months" />
    </div>
  </>
}
