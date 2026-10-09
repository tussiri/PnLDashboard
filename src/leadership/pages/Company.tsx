import { useMemo } from 'react'
import { useApiQuery } from '../../hooks/useApiQuery'
import type { CompanyMonth, CompanyResponse, LeadershipRow } from '../../services/apiTypes'
import { queryKey } from '../../services/queryClient'
import { RevenueMarginChart, seriesColor, StackedMoneyChart, useTokens } from '../charts'
import { rowsOfWeek, segmentOrder, useRows } from '../data'
import { hours, money, moneyK, pct } from '../format'
import { accountSummary, statusOf, type AccountSummary } from '../metrics'
import { monthLabel, monthShort, weekRange } from '../routes'
import { PageHeader, updatedLine } from '../Shell'
import { useLeadership } from '../state'
import { Badge, ChartCard, Empty, Kpi, LoadError, Skeleton, SortTable, Swatch, toneOf, VocabContext, type Column } from '../ui'
import { vocabOf } from '../vocab'

const ratio = (a: number, b: number) => (b ? a / b : null)
const sumBy = (months: CompanyMonth[], f: (m: CompanyMonth) => number) => months.reduce((a, m) => a + f(m), 0)
const allocOf = (m: CompanyMonth) => m.allocations.management_wages + m.allocations.burden + m.allocations.overhead

interface AccountLine { slug: string; name: string; summary: AccountSummary<LeadershipRow> | null; target: number; watchBand?: number; ytdRevenue: number; ytdProfit: number }

/** The company at a glance: the year to date from job cost, the month trend, business units and every account this week. */
export function Company() {
  const { api, keyPrefix, decision, config, featured, optionsFor, weekStart, navigate } = useLeadership()
  const t = useTokens()
  const q = useApiQuery<CompanyResponse>(decision ? queryKey(`${keyPrefix}/leadership/company`, { months: 14 }) : null, (signal) => api.leadershipCompany(14, signal), [api])
  const rowsQuery = useRows('featured', 1)
  const week = useMemo(() => rowsOfWeek(rowsQuery.data?.rows, weekStart), [rowsQuery.data, weekStart])
  const months = q.data?.months ?? []
  const closed = months.filter((m) => m.closed)
  const last = closed.at(-1)
  const year = last?.month.slice(0, 4)
  const ytd = closed.filter((m) => m.month.startsWith(year ?? '-'))
  const prev = closed.at(-2)
  const revenue = sumBy(ytd, (m) => m.revenue)
  const profit = sumBy(ytd, (m) => m.gross_profit)
  const labor = sumBy(ytd, (m) => m.direct_labor)
  const alloc = sumBy(ytd, allocOf)

  const lines: AccountLine[] = useMemo(() => featured.map((a) => {
    const rows = week.filter((r) => r.account_slug === a.slug)
    const o = optionsFor(a)
    return { slug: a.slug, name: a.name, summary: rows.length ? accountSummary(rows, o, segmentOrder(a)) : null, target: o.target, watchBand: o.watchBand,
      ytdRevenue: sumBy(ytd, (m) => m.by_account[a.slug]?.revenue ?? 0), ytdProfit: sumBy(ytd, (m) => m.by_account[a.slug]?.gross_profit ?? 0) }
  }), [featured, week, optionsFor, ytd])
  const weekTotals = lines.reduce((acc, l) => {
    const s = l.summary?.account
    if (s) { acc.invoice += s.invoice; acc.cost += s.cost; acc.target += l.target * s.invoice; acc.over += l.summary!.headerOverHours }
    return acc
  }, { invoice: 0, cost: 0, target: 0, over: 0 })
  const blendedTarget = weekTotals.invoice ? weekTotals.target / weekTotals.invoice : 0.645
  const weekLp = ratio(weekTotals.cost, weekTotals.invoice)

  const units = useMemo(() => {
    const names = [...new Set(months.flatMap((m) => Object.keys(m.by_company)))].filter((n) => n !== 'Unassigned').sort()
    return names.map((name) => {
      const inYtd = ytd.map((m) => m.by_company[name]).filter(Boolean)
      const r = inYtd.reduce((a, x) => a + x.revenue, 0)
      return { name, revenue: r, labor: inYtd.reduce((a, x) => a + x.direct_labor, 0), sub: inYtd.reduce((a, x) => a + x.subcontractors, 0),
        profit: inYtd.reduce((a, x) => a + x.gross_profit, 0) }
    })
  }, [months, ytd])

  const flagged = months.filter((m) => m.flags.length)
  const open = months.filter((m) => !m.closed && m.revenue > 0)
  const accountCols: Column<AccountLine>[] = [
    { key: 'name', header: 'Account', left: true, value: (l) => l.name, className: 'nm' },
    { key: 'inv', header: 'Invoicing', value: (l) => l.summary?.account.invoice ?? null, render: (l) => money(l.summary?.account.invoice) },
    { key: 'lab', header: 'Total labor', value: (l) => l.summary?.account.cost ?? null, render: (l) => money(l.summary?.account.cost) },
    { key: 'lp', header: 'Labor %', value: (l) => l.summary?.account.measurePct ?? null,
      render: (l) => <span className={toneOf(statusOf(l.summary?.account.measurePct ?? null, l.target, l.watchBand))}>{pct(l.summary?.account.measurePct)}</span> },
    { key: 'tgt', header: 'Target', value: (l) => l.target, render: (l) => <span className="neutral">{pct(l.target)}</span> },
    { key: 'over', header: 'Hrs to cut', value: (l) => l.summary?.headerOverHours ?? null, render: (l) => (l.summary ? hours(l.summary.headerOverHours) : '–') },
    { key: 'mgn', header: 'Margin', value: (l) => l.summary?.account.margin ?? null, render: (l) => <span className={(l.summary?.account.margin ?? 0) < 0 ? 'bad' : ''}>{money(l.summary?.account.margin)}</span> },
    { key: 'ytd', header: `Revenue ${year ?? ''} YTD`, value: (l) => l.ytdRevenue, render: (l) => money(l.ytdRevenue) },
    { key: 'gp', header: 'GP YTD', value: (l) => l.ytdProfit, render: (l) => <span className={l.ytdProfit < 0 ? 'bad' : ''}>{money(l.ytdProfit)}</span> },
    { key: 'st', header: 'Status', value: (l) => l.summary?.account.measurePct ?? null,
      render: (l) => (l.summary ? <VocabContext.Provider value={vocabOf(featured.find((a) => a.slug === l.slug))}><Badge status={statusOf(l.summary.account.measurePct, l.target, l.watchBand)} /></VocabContext.Provider> : <Badge status="none" label="No data" />) },
  ]
  type Unit = (typeof units)[number]
  const unitCols: Column<Unit>[] = [
    { key: 'name', header: 'Business unit', left: true, value: (u) => u.name, className: 'nm' },
    { key: 'rev', header: 'Revenue', value: (u) => u.revenue, render: (u) => money(u.revenue) },
    { key: 'lab', header: 'Direct labor', value: (u) => u.labor, render: (u) => money(u.labor) },
    { key: 'lp', header: 'Labor %', value: (u) => ratio(u.labor, u.revenue), render: (u) => pct(ratio(u.labor, u.revenue)) },
    { key: 'sub', header: 'Subcontractors', value: (u) => u.sub, render: (u) => money(u.sub) },
    { key: 'gp', header: 'Gross profit', value: (u) => u.profit, render: (u) => <span className={u.profit < 0 ? 'bad' : ''}>{money(u.profit)}</span> },
    { key: 'gm', header: 'Margin', value: (u) => ratio(u.profit, u.revenue), render: (u) => pct(ratio(u.profit, u.revenue)) },
  ]

  const subtitle = [last ? `Year to date through ${monthLabel(last.month)}` : null, updatedLine(config.data)].filter(Boolean).join('. ')
  return <>
    <PageHeader title="Company" subtitle={subtitle} account={false} target={false} />
    {q.error ? <LoadError error={q.error} onRetry={q.refetch} /> : !q.data ? <Skeleton height={420} /> : !months.length ? <Empty>No job cost loaded.</Empty> : <>
      <div className="kpi-lg">
        <Kpi label={`Revenue ${year} YTD`} value={money(revenue)} sub={`${ytd.length} closed months`} />
        <Kpi label="Gross profit YTD" value={money(profit)} tone={profit < 0 ? 'bad' : ''} sub={`${pct(ratio(profit, revenue))} margin`} />
        <Kpi label="Labor % YTD" value={pct(ratio(labor, revenue))} sub="Direct labor ÷ revenue" />
        {alloc > 0 && <Kpi label="After allocations YTD" value={money(profit - alloc)} tone={profit - alloc < 0 ? 'bad' : ''} sub={`${moneyK(alloc)} allocated`} />}
        {last && <Kpi label={`${monthShort(last.month)} revenue`} value={money(last.revenue)}
          sub={prev ? `${last.revenue >= prev.revenue ? '+' : '−'}${pct(Math.abs(ratio(last.revenue - prev.revenue, prev.revenue) ?? 0))} vs ${monthShort(prev.month)}` : undefined} />}
        <Kpi label="Labor % this week" value={pct(weekLp)} tone={toneOf(statusOf(weekLp, blendedTarget))}
          sub={`${weekStart ? weekRange(weekStart) : ''}; blended target ${pct(blendedTarget)}`} />
      </div>
      {(flagged.length > 0 || open.length > 0) && <dl className="notes">
        {flagged.map((m) => <div key={`f${m.month}`}><dt className="warn">{monthLabel(m.month)}</dt>
          <dd>{m.flags.includes('sub_spike') ? `Subcontractor cost ${money(m.subcontractors)}, well above prior months; check the job cost load` : `Direct labor ${money(m.direct_labor)}, well above prior months; check the job cost load`}</dd></div>)}
        {open.map((m) => <div key={`o${m.month}`}><dt>{monthLabel(m.month)}</dt><dd>Job cost not closed; left out of the year to date</dd></div>)}
      </dl>}
      <div className="charts2">
        <ChartCard title="Revenue and gross margin by month" height={260}
          legend={<><Swatch color={t.accent} label="Closed" /><Swatch color={t.muted} label="Not closed" /><Swatch color={t.ok} label="Gross margin %" /></>}
          chart={<RevenueMarginChart labels={months.map((m) => monthShort(m.month))} revenue={months.map((m) => m.revenue)} closed={months.map((m) => m.closed)}
            marginPct={months.map((m) => ratio(m.gross_profit, m.revenue))} />}
          table={<table><thead><tr><th className="nosort l">Month</th><th className="nosort">Revenue</th><th className="nosort">Gross profit</th><th className="nosort">Margin</th></tr></thead>
            <tbody>{months.map((m) => <tr key={m.month}><td className="l">{monthLabel(m.month)}{m.closed ? '' : ' (open)'}</td><td>{money(m.revenue)}</td><td>{money(m.gross_profit)}</td><td>{pct(ratio(m.gross_profit, m.revenue))}</td></tr>)}</tbody></table>} />
        <ChartCard title="Revenue by business unit" height={260}
          legend={<>{units.map((u, i) => <Swatch key={u.name} color={seriesColor(t, i)} label={u.name} />)}</>}
          chart={<StackedMoneyChart labels={months.map((m) => monthShort(m.month))} series={units.map((u, i) => ({ label: u.name, color: seriesColor(t, i), data: months.map((m) => m.by_company[u.name]?.revenue ?? 0) }))} />}
          table={<table><thead><tr><th className="nosort l">Month</th>{units.map((u) => <th key={u.name} className="nosort">{u.name}</th>)}</tr></thead>
            <tbody>{months.map((m) => <tr key={m.month}><td className="l">{monthShort(m.month)}</td>{units.map((u) => <td key={u.name}>{money(m.by_company[u.name]?.revenue ?? 0)}</td>)}</tr>)}</tbody></table>} />
      </div>
      <div className="card"><div className="ct"><span>Accounts this week</span></div>
        {rowsQuery.error ? <LoadError error={rowsQuery.error} onRetry={rowsQuery.refetch} /> : !rowsQuery.data ? <Skeleton height={200} />
          : <SortTable caption="Accounts this week" rows={lines} columns={accountCols} defaultSort={{ key: 'inv', dir: -1 }} csvName="company-accounts"
            onRowClick={(l) => navigate({ view: 'account', account: l.slug, tab: 'overview' })} rowLabel={(l) => `Open ${l.name}`} />}
      </div>
      <div className="card"><div className="ct"><span>Business units, {year} year to date</span></div>
        <SortTable caption="Business units year to date" rows={units} columns={unitCols} defaultSort={{ key: 'rev', dir: -1 }} csvName="company-business-units" />
      </div>
    </>}
  </>
}
