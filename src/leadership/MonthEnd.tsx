import { useMemo, useState, type ReactNode } from 'react'
import { useApiQuery } from '../hooks/useApiQuery'
import type { CompanyPlCustomer, CompanyPlMonth, CompanyPlResponse } from '../services/apiTypes'
import { queryKey } from '../services/queryClient'
import { GroupedMoneyChart, MarginChart, MoneyLinesChart, MoneyPctChart, StackedBarsLineChart, useTokens } from './charts'
import { money, pct } from './format'
import {
  accountOver, ADDBACK_LABEL, addbackKinds, bridgeOf, columnsOf, companyNames, companyOver, customerValue, groupOver, marginStatus, monthName, periodOf, periodsOf, rankCustomers,
  ratio, sumMonths, type Period, type ProfitView,
} from './monthEndData'
import './monthEnd.css'
import { CompanyTabs } from './pages/CompanyTabs'
import { MONTH_END_TABS, monthShort, type MonthEndTab } from './routes'
import { PageHeader } from './Shell'
import { useLeadership } from './state'
import { ChartCard, Empty, Kpi, LoadError, Pills, Skeleton, SortTable, Swatch, type Column } from './ui'

/** Months the view reads: a year of Cross Tab months. */
const MONTHS = 12

/** "$1.24M", "$184K", "($32K)". */
export function fk(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '–'
  const a = Math.abs(v)
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `$${Math.round(a / 1e3).toLocaleString('en-US')}K` : `$${Math.round(a)}`
  return v < 0 ? `(${s})` : s
}
const tone = (v: number | null | undefined) => (v == null ? '' : v < -0.5 ? 'bad' : v > 0.5 ? 'ok' : 'neutral')
const neg = (v: number) => (v < -0.5 ? 'bad' : '')

/** The change against the prior month: "+$42K vs Sep", in the good or bad tone (goodDown: a fall is good). */
function Delta({ now, before, label, points, goodDown }: { now: number | null | undefined; before: number | null | undefined; label: string; points?: boolean; goodDown?: boolean }) {
  if (now == null || before == null || !Number.isFinite(now) || !Number.isFinite(before)) return null
  const d = now - before
  if (Math.abs(d) < (points ? 0.0005 : 0.5)) return <><br /><span className="neutral">Flat vs {label}</span></>
  const good = goodDown ? d < 0 : d > 0
  return <><br /><span className={good ? 'ok' : 'bad'}>{d > 0 ? '+' : '−'}{points ? `${Math.abs(d * 100).toFixed(1)} pts` : fk(Math.abs(d))} vs {label}</span></>
}

const STATUS: Record<ReturnType<typeof marginStatus>, { cls: string; label: string }> = {
  none: { cls: 'bnone', label: 'No revenue' }, loss: { cls: 'bbad', label: 'Loss' }, thin: { cls: 'bwarn', label: 'Thin' }, profit: { cls: 'bok', label: 'Profit' },
}
const StatusBadge = ({ margin }: { margin: number | null }) => { const s = STATUS[marginStatus(margin)]; return <span className={`badge ${s.cls}`}>{s.label}</span> }

interface Ctx {
  months: CompanyPlMonth[]
  labels: string[]
  periods: Period[]
  cols: Period[]
  period: Period
  /** The period summed. */
  s: CompanyPlMonth
  /** The month before a single-month period, summed (null otherwise). */
  prev: CompanyPlMonth | null
  prevLabel: string
  selected: boolean[]
  groups: { key: string; name: string; color: string }[]
  pick: (index: number) => void
  featured: { slug: string; name: string }[]
}

/** A monthly table row: one value per column (a set of month indexes), optionally with its % of a base. */
interface Row { label: string; value: (idx: number[]) => number | null; base?: (idx: number[]) => number; key?: boolean; color?: boolean; pct?: boolean; section?: boolean }

/** Every month, the year to date and the last two months as columns, the selected period highlighted; with `withPct` each value also as a % of its row's base. */
function MonthTable({ ctx, rows, caption, withPct }: { ctx: Ctx; rows: Row[]; caption: string; withPct?: boolean }) {
  const isSel = (c: Period) => c.key === ctx.period.key
  const span = ctx.cols.length * (withPct ? 2 : 1) + 1
  return <div className="tw"><table className="pl">
    <caption className="sr-only">{caption}</caption>
    <thead><tr><th className="nosort" scope="col"><span className="sr-only">Line</span></th>
      {ctx.cols.map((c) => <MonthHead key={c.key} c={c} sel={isSel(c)} withPct={withPct} />)}</tr></thead>
    <tbody>{rows.map((r, i) => r.section
      ? <tr key={i} className="sec"><th scope="rowgroup" colSpan={span}>{r.label}</th></tr>
      : <tr key={i} className={r.key ? 'key' : ''}><th scope="row">{r.label}</th>
        {ctx.cols.map((c) => {
          const v = r.value(c.idx)
          const sel = isSel(c) ? ' sel' : ''
          const multi = c.idx.length > 1 ? ' tcol' : ''
          const cls = r.color && v != null ? neg(v) : ''
          const text = v == null ? '–' : r.pct ? pct(v) : Math.abs(v) < 0.5 ? '–' : money(v)
          if (!withPct) return <td key={c.key} className={`${sel}${multi} ${cls}`}>{text}</td>
          const base = r.base?.(c.idx) ?? 0
          const share = v == null || r.pct ? null : ratio(v, base)
          return [<td key={c.key} className={`${sel}${multi} ${cls}`}>{text}</td>,
            <td key={`${c.key}%`} className={`pc${sel} ${cls}`}>{share == null || Math.abs(share) < 0.00005 ? '–' : share < 0 ? `(${pct(-share)})` : pct(share)}</td>]
        })}</tr>)}
    </tbody></table></div>
}
const MonthHead = ({ c, sel, withPct }: { c: Period; sel: boolean; withPct?: boolean }) => <>
  <th className={`nosort${sel ? ' sel' : ''}${c.idx.length > 1 ? ' tcol' : ''}`} scope="col">{c.short}</th>
  {withPct && <th className={`nosort pc${sel ? ' sel' : ''}`} scope="col">% Rev</th>}</>

const sec = (label: string): Row => ({ label, value: () => null, section: true })

/** The month-end company view: the company P&L on Finance's basis (the Cross Tab Income Statement by job, the overhead rule and Finance's adjustments), in the tabs of Finance's company dashboard. */
export default function MonthEnd() {
  const { api, keyPrefix, decision, route, navigate, featured } = useLeadership()
  const t = useTokens()
  const q = useApiQuery<CompanyPlResponse>(decision ? queryKey(`${keyPrefix}/leadership/company-pl`, { months: MONTHS }) : null, (signal) => api.companyPl(MONTHS, signal), [api])
  const months = useMemo(() => q.data?.months ?? [], [q.data])
  const periods = useMemo(() => periodsOf(months), [months])
  const tab: MonthEndTab = route.monthEnd?.tab ?? 'overview'
  const period = periodOf(periods, route.monthEnd?.period)
  const setPeriod = (key: string) => navigate({ monthEnd: { ...route.monthEnd, period: key === periods[0]?.key ? undefined : key } }, { replace: true })
  const setTab = (next: MonthEndTab) => navigate({ monthEnd: { ...route.monthEnd, tab: next === 'overview' ? undefined : next } })
  const names = companyNames(months)
  const last = months.at(-1)
  const tabLabel: Record<MonthEndTab, string> = {
    overview: 'Overview', pl: 'Monthly P&L', customers: 'Customers', accounts: 'Major accounts', companies: names.length === 2 ? names.join(' + ') : 'By company',
    overhead: 'Corporate overhead', ebita: 'EBITA', preview: last ? `${monthName(last.month)} preview` : 'Preview',
  }
  const header = <PageHeader title="Company" subtitle={period?.label} account={false} week={false} target={false}
    extra={periods.length > 0 && <><label htmlFor="me-per">Period</label>
      <select id="me-per" value={period?.key ?? ''} onChange={(e) => setPeriod(e.target.value)}>{periods.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></>} />

  if (q.error) return <>{header}<CompanyTabs /><LoadError error={q.error} onRetry={q.refetch} /></>
  if (!q.data) return <>{header}<CompanyTabs /><Skeleton height={420} /></>
  if (!months.length || !period) return <>{header}<CompanyTabs /><Empty>No Cross Tab Income Statement by job loaded.</Empty></>

  const s = sumMonths(months, period.idx)
  const single = period.idx.length === 1 && period.idx[0] > 0
  const ctx: Ctx = {
    months, labels: months.map((m) => monthShort(m.month)), periods, cols: columnsOf(months, periods), period, s,
    prev: single ? months[period.idx[0] - 1] : null, prevLabel: single ? monthShort(months[period.idx[0] - 1].month) : '',
    selected: months.map((_, i) => period.idx.includes(i)),
    groups: (last?.groups ?? []).map((g, i) => ({ key: g.key, name: g.name, color: t.series[i % t.series.length] })),
    pick: (i) => setPeriod(months[i].month.slice(0, 7)),
    featured: featured.map((a) => ({ slug: a.slug, name: a.name })),
  }
  const view: Record<MonthEndTab, () => ReactNode> = {
    overview: () => <Overview ctx={ctx} />, pl: () => <MonthlyPl ctx={ctx} />, customers: () => <Customers ctx={ctx} />, accounts: () => <MajorAccounts ctx={ctx} />,
    companies: () => <Companies ctx={ctx} names={names} />, overhead: () => <Overhead ctx={ctx} jobs={q.data!.settings.overhead_jobs} />, ebita: () => <Ebita ctx={ctx} />,
    preview: () => <Preview ctx={ctx} />,
  }
  return <div className="me">
    {header}
    <CompanyTabs />
    <Pills label="Month-end views" value={tab} onChange={setTab} options={MONTH_END_TABS.map((k) => ({ value: k, label: tabLabel[k] }))} />
    {view[tab]()}
    <p className="foot">Cross Tab Income Statement by job: {q.data.loaded.map((l) => `${monthShort(l.month)}${l.loaded_at ? ` loaded ${l.loaded_at.slice(0, 10)}` : ''}`).join(', ')}</p>
  </div>
}

// ---------------------------------------------------------------------------------------------- Overview

function Overview({ ctx }: { ctx: Ctx }) {
  const t = useTokens()
  const { s, prev, prevLabel, months, labels, period, groups } = ctx
  const c = s.company
  const nm = ratio(c.net_profit, c.operating_revenue)
  const ytd = period.key === 'ytd'
  const end = Math.max(...period.idx)
  const year = months[end].month.slice(0, 4)
  const inYear = months.slice(0, end + 1).filter((m) => m.month.startsWith(year))
  const toDate = inYear.reduce((a, m) => a + m.company.net_profit, 0)
  const red = period.idx.filter((i) => months[i].company.net_profit < 0)
  const p = prev?.company
  return <>
    <div className="kpi-lg">
      <Kpi label="Revenue" value={fk(c.operating_revenue)} sub={<>{period.label}<Delta now={c.operating_revenue} before={p?.operating_revenue} label={prevLabel} /></>} />
      <Kpi label="Gross profit before overhead" value={fk(c.gross_profit)} tone={tone(c.gross_profit)}
        sub={<>{pct(c.gross_margin)} margin<Delta now={c.gross_margin} before={p?.gross_margin} label={prevLabel} points /></>} />
      <Kpi label="Corporate overhead" value={fk(c.overhead)} sub={<>{pct(c.overhead_pct)} of revenue<Delta now={c.overhead} before={p?.overhead} label={prevLabel} goodDown /></>} />
      <Kpi label="Net profit" value={fk(c.net_profit)} tone={tone(c.net_profit)} sub={<>{pct(nm)} margin<Delta now={c.net_profit} before={p?.net_profit} label={prevLabel} /></>} />
      {ytd
        ? <Kpi label="Months in the red" value={`${red.length} of ${period.idx.length}`} tone={red.length ? 'bad' : 'ok'} sub={red.length ? red.map((i) => labels[i]).join(', ') : undefined} />
        : <Kpi label="Net profit year to date" value={fk(toDate)} tone={tone(toDate)} sub={inYear.length > 1 ? `${monthName(inYear[0].month)} to ${monthName(months[end].month)}` : monthName(months[end].month)} />}
    </div>
    <ChartCard title="Net profit after overhead by group" height={290}
      legend={<>{groups.map((g) => <Swatch key={g.key} color={g.color} label={g.name} />)}<Swatch color={t.text} label="Company net profit" line /></>}
      chart={<StackedBarsLineChart labels={labels} selected={ctx.selected} onPick={ctx.pick} ariaLabel="Net profit after overhead by group and company net profit by month"
        series={groups.map((g) => ({ label: g.name, color: g.color, data: months.map((m) => m.groups.find((x) => x.key === g.key)?.after_overhead ?? 0) }))}
        line={{ label: 'Company net profit', data: months.map((m) => m.company.net_profit) }} />}
      table={<MonthTable ctx={ctx} caption="Net profit after overhead by group" rows={[...groups.map((g) => ({ label: g.name, color: true, value: (idx: number[]) => groupOver(months, idx, g.key)?.after_overhead ?? 0 })),
        { label: 'Company net profit', key: true, color: true, value: (idx: number[]) => sumMonths(months, idx).company.net_profit }]} />} />
    <div className="seg-grid me-groups">
      {groups.map((g) => {
        const x = s.groups.find((y) => y.key === g.key)
        if (!x) return null
        return <div key={g.key} className="card">
          <div className="seg-hdr"><div><div className="seg-name"><span className="dot" style={{ background: g.color }} />{g.name}</div>
            <div className="seg-sub">{pct(ratio(x.revenue, c.operating_revenue))} of revenue</div></div><StatusBadge margin={x.margin} /></div>
          <div className="kpi4">
            <Kpi small label="Revenue" value={fk(x.revenue)} />
            <Kpi small label="Before overhead" value={fk(x.before_overhead)} tone={tone(x.before_overhead)} sub={pct(ratio(x.before_overhead, x.revenue))} />
            <Kpi small label="Overhead" value={fk(-x.overhead)} sub={`${pct(ratio(x.overhead, x.revenue))} of revenue`} />
            <Kpi small label="After overhead" value={fk(x.after_overhead)} tone={tone(x.after_overhead)} sub={pct(x.margin)} />
          </div></div>
      })}
    </div>
    <div className="charts2">
      <ChartCard title="Revenue by group" height={260} legend={<>{groups.map((g) => <Swatch key={g.key} color={g.color} label={g.name} />)}</>}
        chart={<StackedBarsLineChart labels={labels} selected={ctx.selected} onPick={ctx.pick} ariaLabel="Revenue by group by month"
          series={groups.map((g) => ({ label: g.name, color: g.color, data: months.map((m) => m.groups.find((x) => x.key === g.key)?.revenue ?? 0) }))} />}
        table={<MonthTable ctx={ctx} caption="Revenue by group" rows={[...groups.map((g) => ({ label: g.name, value: (idx: number[]) => groupOver(months, idx, g.key)?.revenue ?? 0 })),
          { label: 'Total', key: true, value: (idx: number[]) => sumMonths(months, idx).company.operating_revenue }]} />} />
      <ChartCard title="Corporate overhead: net cost and % of revenue" height={260}
        legend={<><Swatch color={t.accent} label="Overhead net cost" /><Swatch color={t.bad} label="% of revenue" line /></>}
        chart={<MoneyPctChart labels={labels} selected={ctx.selected} onPick={ctx.pick} ariaLabel="Corporate overhead net cost and share of revenue by month"
          bars={{ label: 'Overhead net cost', data: months.map((m) => m.overhead.cost) }} pct={{ label: '% of revenue', data: months.map((m) => m.company.overhead_pct) }} />}
        table={<MonthTable ctx={ctx} caption="Corporate overhead by month" rows={[{ label: 'Overhead net cost', value: (idx) => sumMonths(months, idx).overhead.cost },
          { label: '% of revenue', pct: true, value: (idx) => sumMonths(months, idx).company.overhead_pct }]} />} />
    </div>
  </>
}

// ------------------------------------------------------------------------------------------ Monthly P&L

function MonthlyPl({ ctx }: { ctx: Ctx }) {
  const { months, groups } = ctx
  const sum = (idx: number[]) => sumMonths(months, idx)
  const rev = (idx: number[]) => sum(idx).company.operating_revenue
  const fixed = (k: string) => months.some((m) => (m.groups.find((g) => g.key === k)?.fixed_charge ?? 0) !== 0)
  const staff = (k: string) => months.some((m) => (m.groups.find((g) => g.key === k)?.direct_staff ?? 0) !== 0)
  const pool = (k: string) => months.some((m) => (m.groups.find((g) => g.key === k)?.pool_charge ?? 0) !== 0)
  const rows: Row[] = [
    sec('Company'),
    { label: 'Revenue', value: rev, base: rev },
    { label: 'Gross profit before overhead', value: (idx) => sum(idx).company.gross_profit, base: rev, color: true },
    { label: 'Operating expenses on the jobs', value: (idx) => -sum(idx).company.operating_expense, base: rev },
    { label: 'Corporate overhead', value: (idx) => -sum(idx).company.overhead, base: rev },
    { label: 'Net profit', value: (idx) => sum(idx).company.net_profit, base: rev, key: true, color: true },
  ]
  for (const g of groups) {
    const go = (idx: number[]) => groupOver(months, idx, g.key)
    const grev = (idx: number[]) => go(idx)?.revenue ?? 0
    rows.push(sec(g.name),
      { label: 'Revenue', value: grev, base: grev },
      { label: 'Gross profit', value: (idx) => go(idx)?.gross_profit ?? 0, base: grev, color: true },
      { label: 'Net before overhead', value: (idx) => go(idx)?.before_overhead ?? 0, base: grev, color: true },
      ...(staff(g.key) ? [{ label: 'Direct account staff', value: (idx: number[]) => -(go(idx)?.direct_staff ?? 0), base: grev }] : []),
      ...(fixed(g.key) ? [{ label: 'Fixed overhead', value: (idx: number[]) => -(go(idx)?.fixed_charge ?? 0), base: grev }] : []),
      ...(pool(g.key) ? [{ label: 'Overhead pool share', value: (idx: number[]) => -(go(idx)?.pool_charge ?? 0), base: grev }] : []),
      { label: 'Net after overhead', value: (idx) => go(idx)?.after_overhead ?? 0, base: grev, key: true, color: true })
  }
  return <div className="card"><MonthTable ctx={ctx} caption="Monthly P&L by group" rows={rows} withPct /></div>
}

// -------------------------------------------------------------------------------------------- Customers

function Customers({ ctx }: { ctx: Ctx }) {
  const t = useTokens()
  const [view, setView] = useState<ProfitView>('after')
  const customers = ctx.s.customers ?? []
  const { top, bottom } = rankCustomers(customers, view)
  const lab = view === 'after' ? 'after overhead' : 'before overhead'
  const margin = (c: CompanyPlCustomer) => ratio(customerValue(c, view), c.revenue)
  const groupName = (k: string) => ctx.groups.find((g) => g.key === k)?.name ?? k
  const list = [...top.slice(0, 10), ...bottom.slice(0, 5).reverse()]
  const rank = (rows: CompanyPlCustomer[], none: string) => rows.length
    ? <ol className="rk-list">{rows.slice(0, 3).map((c, i) => <li key={c.name} className="rk">
      <span className="rk-n">{i + 1}</span><span className="rk-name" title={c.name}>{c.name}</span><b className={`rk-v ${tone(customerValue(c, view))}`}>{fk(customerValue(c, view))}</b>
      <span className="rk-sub">{c.jobs.length} {c.jobs.length === 1 ? 'job' : 'jobs'}, {fk(c.revenue)} revenue</span><span className="rk-m">{c.revenue ? `${pct(margin(c))} margin` : 'No revenue'}</span></li>)}</ol>
    : <p className="empty">{none}</p>
  const cols: Column<CompanyPlCustomer>[] = [
    { key: 'name', header: 'Customer', left: true, value: (c) => c.name, className: 'nm' },
    { key: 'group', header: 'Group', left: true, value: (c) => groupName(c.group), render: (c) => <span className="neutral">{groupName(c.group)}</span> },
    { key: 'jobs', header: 'Jobs', value: (c) => c.jobs.length },
    { key: 'rev', header: 'Revenue', value: (c) => c.revenue, render: (c) => money(c.revenue) },
    { key: 'bef', header: 'Before overhead', value: (c) => c.before_overhead, render: (c) => <span className={neg(c.before_overhead)}>{money(c.before_overhead)}</span> },
    { key: 'bm', header: 'Margin', value: (c) => ratio(c.before_overhead, c.revenue), render: (c) => <span className="neutral">{pct(ratio(c.before_overhead, c.revenue))}</span> },
    { key: 'oh', header: 'Overhead', value: (c) => -c.overhead, render: (c) => (Math.abs(c.overhead) < 0.5 ? '–' : money(-c.overhead)) },
    { key: 'aft', header: 'After overhead', value: (c) => c.after_overhead, render: (c) => <b className={neg(c.after_overhead)}>{money(c.after_overhead)}</b> },
    { key: 'am', header: 'Margin', value: (c) => ratio(c.after_overhead, c.revenue), render: (c) => <span className="neutral">{pct(ratio(c.after_overhead, c.revenue))}</span> },
    { key: 'st', header: 'Status', value: (c) => margin(c), render: (c) => <StatusBadge margin={margin(c)} /> },
  ]
  if (!customers.length) return <Empty>No customers in {ctx.period.label}.</Empty>
  return <>
    <Pills label="Profit measure" value={view} onChange={setView} options={[{ value: 'after', label: 'After overhead' }, { value: 'before', label: 'Before overhead' }]} />
    <div className="charts2 even">
      <div className="card"><div className="ct"><span>Top 3 customers for profit, {lab}</span></div>{rank(top, `No customer made money in ${ctx.period.label}.`)}</div>
      <div className="card"><div className="ct"><span>Top 3 customers for loss, {lab}</span></div>{rank(bottom, `No customer lost money in ${ctx.period.label}.`)}</div>
    </div>
    {list.length > 0 && <ChartCard title={`Net profit by customer, ${lab}: top ${Math.min(10, top.length)} and bottom ${Math.min(5, bottom.length)}`} height={Math.max(180, list.length * 24 + 40)}
      legend={<><Swatch color={t.ok} label="Profit" /><Swatch color={t.bad} label="Loss" /></>}
      chart={<MarginChart labels={list.map((c) => c.name)} values={list.map((c) => customerValue(c, view))} tones={list.map((c) => (customerValue(c, view) < 0 ? 'bad' : 'ok'))}
        details={list.map((c) => `${money(customerValue(c, view))} on ${money(c.revenue)} revenue (${c.revenue ? pct(margin(c)) : 'no revenue'})`)} ariaLabel={`Net profit by customer, ${lab}`} />}
      table={<table><thead><tr><th className="nosort l">Customer</th><th className="nosort">Net profit</th><th className="nosort">Revenue</th></tr></thead>
        <tbody>{list.map((c) => <tr key={c.name}><td className="l">{c.name}</td><td className={neg(customerValue(c, view))}>{money(customerValue(c, view))}</td><td>{money(c.revenue)}</td></tr>)}</tbody></table>} />}
    <div className="card"><SortTable caption={`Customers, ${ctx.period.label}`} rows={customers} columns={cols} defaultSort={{ key: view === 'after' ? 'aft' : 'bef', dir: -1 }} csvName="month-end-customers" pageSize={25} /></div>
  </>
}

// --------------------------------------------------------------------------------------- Major accounts

function MajorAccounts({ ctx }: { ctx: Ctx }) {
  const { months, labels, s } = ctx
  const t = useTokens()
  const accounts = ctx.featured.filter((a) => months.some((m) => m.accounts[a.slug])).sort((a, b) => (s.accounts[b.slug]?.revenue ?? 0) - (s.accounts[a.slug]?.revenue ?? 0))
  const [chosen, setChosen] = useState<string | null>(null)
  const slug = accounts.find((a) => a.slug === chosen)?.slug ?? accounts[0]?.slug
  if (!slug) return <Empty>No account has Cross Tab lines.</Empty>
  const color = (i: number) => t.series[i % t.series.length]
  const ao = (idx: number[]) => accountOver(months, idx, slug)
  const arev = (idx: number[]) => ao(idx)?.revenue ?? 0
  const line = (label: string, f: (a: NonNullable<ReturnType<typeof ao>>) => number, opts: Partial<Row> = {}): Row => ({ label, value: (idx) => { const a = ao(idx); return a ? f(a) : 0 }, base: arev, ...opts })
  const name = accounts.find((a) => a.slug === slug)?.name ?? slug
  return <>
    <div className="seg-grid me-accounts">
      {accounts.map((a, i) => {
        const x = s.accounts[a.slug]
        return <div key={a.slug} className="card">
          <div className="seg-hdr"><div className="seg-name"><span className="dot" style={{ background: color(i) }} />{a.name}</div><StatusBadge margin={x ? ratio(x.after_overhead, x.revenue) : null} /></div>
          <div className="kpi4">
            <Kpi small label="Revenue" value={fk(x?.revenue)} />
            <Kpi small label="Before overhead" value={fk(x?.before_overhead)} tone={tone(x?.before_overhead)} sub={x ? pct(ratio(x.before_overhead, x.revenue)) : undefined} />
            <Kpi small label="Overhead" value={fk(x ? -x.overhead : null)} />
            <Kpi small label="After overhead" value={fk(x?.after_overhead)} tone={tone(x?.after_overhead)} sub={x ? pct(ratio(x.after_overhead, x.revenue)) : undefined} />
          </div></div>
      })}
    </div>
    <ChartCard title="Net profit before corporate overhead, by month" height={280} legend={<>{accounts.map((a, i) => <Swatch key={a.slug} color={color(i)} label={a.name} line />)}</>}
      chart={<MoneyLinesChart labels={labels} current={Math.max(...ctx.period.idx)} onPick={ctx.pick}
        series={accounts.map((a, i) => ({ name: a.name, color: color(i), values: months.map((m) => m.accounts[a.slug]?.before_overhead ?? null) }))} />}
      table={<MonthTable ctx={ctx} caption="Net profit before overhead by account" rows={accounts.map((a) => ({ label: a.name, color: true, value: (idx: number[]) => accountOver(months, idx, a.slug)?.before_overhead ?? 0 }))} />} />
    <Pills label="Account" value={slug} onChange={setChosen} options={accounts.map((a) => ({ value: a.slug, label: a.name }))} />
    <div className="card"><div className="ct"><span>{name}</span></div>
      <MonthTable ctx={ctx} caption={`${name} P&L by month`} withPct rows={[
        line('Revenue', (a) => a.revenue, { key: true }),
        line('Direct labor', (a) => -a.direct_labor), line('Payroll taxes & insurance', (a) => -a.payroll_taxes_insurance),
        line('Subcontractors', (a) => -a.subcontractors), line('Supplies', (a) => -a.supplies), line('Other direct costs', (a) => -a.other_direct),
        line('Gross profit', (a) => a.gross_profit, { key: true, color: true }),
        line('Operating expenses on the jobs', (a) => -a.operating_expense),
        line('Net before overhead', (a) => a.before_overhead, { key: true, color: true }),
        line('Corporate overhead', (a) => -a.overhead),
        line('Net after overhead', (a) => a.after_overhead, { key: true, color: true }),
      ]} /></div>
  </>
}

// ------------------------------------------------------------------------------------------- Companies

function Companies({ ctx, names }: { ctx: Ctx; names: string[] }) {
  const t = useTokens()
  const { months, labels, s, prev, prevLabel } = ctx
  if (!names.length) return <Empty>No company on the Cross Tab.</Empty>
  const color = (i: number) => t.series[i % t.series.length]
  const co = (idx: number[], n: string) => companyOver(months, idx, n)
  const combinedRev = (idx: number[]) => names.reduce((a, n) => a + (co(idx, n)?.revenue ?? 0), 0)
  const combinedNet = (idx: number[]) => names.reduce((a, n) => a + (co(idx, n)?.net_profit ?? 0), 0)
  const rows: Row[] = []
  for (const n of names) {
    const r = (idx: number[]) => co(idx, n)?.revenue ?? 0
    rows.push(sec(n), { label: 'Revenue', value: r, base: r }, { label: 'Gross profit', value: (idx) => co(idx, n)?.gross_profit ?? 0, base: r, color: true },
      { label: 'Net before overhead', value: (idx) => co(idx, n)?.before_overhead ?? 0, base: r, color: true },
      { label: 'Corporate overhead', value: (idx) => -(co(idx, n)?.overhead ?? 0), base: r },
      { label: 'Net profit', value: (idx) => co(idx, n)?.net_profit ?? 0, base: r, key: true, color: true })
  }
  if (names.length > 1) rows.push(sec('Combined'), { label: 'Revenue', value: combinedRev, base: combinedRev }, { label: 'Net profit', value: combinedNet, base: combinedRev, key: true, color: true })
  return <>
    <div className="kpi-lg">
      {names.map((n) => { const x = s.companies?.[n]; return <Kpi key={n} label={`${n} net profit`} value={fk(x?.net_profit)} tone={tone(x?.net_profit)}
        sub={<>{x ? `${pct(ratio(x.net_profit, x.revenue))} margin on ${fk(x.revenue)}` : '–'}<Delta now={x?.net_profit} before={prev?.companies?.[n]?.net_profit} label={prevLabel} /></>} /> })}
      {names.length > 1 && <Kpi label="Combined net profit" value={fk(combinedNet(ctx.period.idx))} tone={tone(combinedNet(ctx.period.idx))} sub={`${pct(ratio(combinedNet(ctx.period.idx), combinedRev(ctx.period.idx)))} margin`} />}
    </div>
    <ChartCard title={`Net profit by month: ${names.join(' and ')}`} height={280}
      legend={<>{names.map((n, i) => <Swatch key={n} color={color(i)} label={n} />)}{names.length > 1 && <Swatch color={t.text} label="Combined" line />}</>}
      chart={<StackedBarsLineChart labels={labels} selected={ctx.selected} onPick={ctx.pick} ariaLabel="Net profit by company by month"
        series={names.map((n, i) => ({ label: n, color: color(i), data: months.map((m) => m.companies?.[n]?.net_profit ?? 0) }))}
        line={names.length > 1 ? { label: 'Combined', data: months.map((m) => names.reduce((a, n) => a + (m.companies?.[n]?.net_profit ?? 0), 0)) } : undefined} />}
      table={<MonthTable ctx={ctx} caption="Net profit by company" rows={names.map((n) => ({ label: n, color: true, value: (idx: number[]) => co(idx, n)?.net_profit ?? 0 }))} />} />
    <div className="card"><div className="ct"><span>{names.length > 1 ? `${names.join(' + ')} combined` : names[0]}</span></div><MonthTable ctx={ctx} caption="Companies by month" rows={rows} withPct /></div>
    {names.map((n) => {
      const r = (idx: number[]) => co(idx, n)?.revenue ?? 0
      const l = (label: string, f: (c: NonNullable<ReturnType<typeof co>>) => number, opts: Partial<Row> = {}): Row => ({ label, value: (idx) => { const c = co(idx, n); return c ? f(c) : 0 }, base: r, ...opts })
      return <div key={n} className="card"><div className="ct"><span>{n} income statement</span></div>
        <MonthTable ctx={ctx} caption={`${n} income statement`} withPct rows={[
          l('Revenue', (c) => c.revenue, { key: true }), l('Direct labor', (c) => -c.direct_labor), l('Payroll taxes & insurance', (c) => -c.payroll_taxes_insurance),
          l('Subcontractors', (c) => -c.subcontractors), l('Supplies', (c) => -c.supplies), l('Other direct costs', (c) => -c.other_direct),
          l('Gross profit', (c) => c.gross_profit, { key: true, color: true }), l('Operating expenses on the jobs', (c) => -c.operating_expense),
          l('Corporate overhead', (c) => -c.overhead), l('Net profit', (c) => c.net_profit, { key: true, color: true }),
        ]} /></div>
    })}
  </>
}

// -------------------------------------------------------------------------------------------- Overhead

function Overhead({ ctx, jobs }: { ctx: Ctx; jobs: string[] }) {
  const { months, labels, s, prev, prevLabel, groups } = ctx
  const o = s.overhead
  const sum = (idx: number[]) => sumMonths(months, idx)
  const go = (idx: number[], k: string) => groupOver(months, idx, k)
  const has = (f: (g: NonNullable<ReturnType<typeof go>>) => number) => groups.filter((g) => months.some((m) => { const x = m.groups.find((y) => y.key === g.key); return x ? f(x) !== 0 : false }))
  const fixedGroups = has((g) => g.fixed_charge), staffGroups = has((g) => g.direct_staff), poolGroups = has((g) => g.pool_charge)
  const list = (gs: typeof groups, f: (k: string) => number) => gs.map((g) => `${g.name} ${fk(f(g.key))}`).join(', ')
  return <>
    <div className="kpi-lg">
      <Kpi label="Overhead net cost" value={fk(o.cost)} sub={<>Jobs {jobs.join(', ')}<Delta now={o.cost} before={prev?.overhead.cost} label={prevLabel} goodDown /></>} />
      <Kpi label="% of revenue" value={pct(s.company.overhead_pct)} sub={<>Revenue excluding the overhead jobs<Delta now={s.company.overhead_pct} before={prev?.company.overhead_pct} label={prevLabel} points goodDown /></>} />
      <Kpi label="Direct account staff" value={fk(o.direct_staff)} sub={o.direct_staff ? list(staffGroups, (k) => s.groups.find((g) => g.key === k)?.direct_staff ?? 0) : undefined} />
      <Kpi label="Fixed charges" value={fk(o.fixed)} sub={fixedGroups.map((g) => g.name).join(', ') || undefined} />
      <Kpi label="Pool spread by revenue" value={fk(o.pool)} sub={poolGroups.map((g) => `${g.name} ${pct(s.groups.find((x) => x.key === g.key)?.pool_share)}`).join(', ') || undefined} />
    </div>
    <ChartCard title="Who carries the overhead" height={280} legend={<>{groups.map((g) => <Swatch key={g.key} color={g.color} label={g.name} />)}</>}
      chart={<StackedBarsLineChart labels={labels} selected={ctx.selected} onPick={ctx.pick} ariaLabel="Overhead carried by group by month"
        series={groups.map((g) => ({ label: g.name, color: g.color, data: months.map((m) => m.groups.find((x) => x.key === g.key)?.overhead ?? 0) }))} />}
      table={<MonthTable ctx={ctx} caption="Overhead carried by group" rows={groups.map((g) => ({ label: g.name, value: (idx: number[]) => go(idx, g.key)?.overhead ?? 0 }))} />} />
    <div className="card"><MonthTable ctx={ctx} caption="Corporate overhead by month" rows={[
      sec('Overhead to charge out'),
      { label: 'Overhead net cost', key: true, value: (idx) => sum(idx).overhead.cost },
      { label: 'Revenue on overhead jobs', value: (idx) => sum(idx).overhead.revenue_on_overhead_jobs },
      { label: '% of revenue', pct: true, value: (idx) => sum(idx).company.overhead_pct },
      ...(fixedGroups.length || staffGroups.length ? [sec('Charged directly')] : []),
      ...fixedGroups.map((g) => ({ label: `Fixed charge: ${g.name}`, value: (idx: number[]) => go(idx, g.key)?.fixed_charge ?? 0 })),
      ...staffGroups.map((g) => ({ label: `Direct staff: ${g.name}`, value: (idx: number[]) => go(idx, g.key)?.direct_staff ?? 0 })),
      sec('Spread by revenue'),
      { label: 'Pool left to spread', key: true, value: (idx) => sum(idx).overhead.pool },
      ...poolGroups.map((g) => ({ label: `${g.name} share`, pct: true, value: (idx: number[]) => ratio(go(idx, g.key)?.pool_charge ?? 0, sum(idx).overhead.pool) })),
      sec('Total carried by group'),
      ...groups.map((g) => ({ label: g.name, value: (idx: number[]) => go(idx, g.key)?.overhead ?? 0 })),
    ]} /></div>
  </>
}

// ----------------------------------------------------------------------------------------------- EBITA

function Ebita({ ctx }: { ctx: Ctx }) {
  const t = useTokens()
  const { months, labels, s, prev, prevLabel, groups } = ctx
  const e = s.ebita
  if (!e) return <Empty>No EBITA for {ctx.period.label}.</Empty>
  const sum = (idx: number[]) => sumMonths(months, idx)
  const shown = addbackKinds.filter((k) => months.some((m) => (m.ebita?.[k] ?? 0) !== 0))
  const rev = s.company.operating_revenue
  return <>
    <div className="kpi-lg">
      <Kpi label="EBITA" value={fk(e.ebita)} tone={tone(e.ebita)} sub={<>{pct(ratio(e.ebita, rev))} margin<Delta now={e.ebita} before={prev?.ebita?.ebita} label={prevLabel} /></>} />
      <Kpi label="Net profit" value={fk(s.company.net_profit)} tone={tone(s.company.net_profit)} sub={`${pct(ratio(s.company.net_profit, rev))} margin`} />
      {shown.map((k) => <Kpi key={k} label={ADDBACK_LABEL[k]} value={fk(e[k])} sub={k === 'depreciation' ? 'Not added back' : k === 'interest' || k === 'amortization' || k === 'income_tax' ? 'Added back' : undefined} />)}
    </div>
    <ChartCard title="EBITA by month" height={280} legend={<>{groups.map((g) => <Swatch key={g.key} color={g.color} label={g.name} />)}<Swatch color={t.text} label="Company EBITA" line /></>}
      chart={<StackedBarsLineChart labels={labels} selected={ctx.selected} onPick={ctx.pick} ariaLabel="EBITA by group and company EBITA by month"
        series={groups.map((g) => ({ label: g.name, color: g.color, data: months.map((m) => m.ebita?.groups[g.key]?.ebita ?? 0) }))}
        line={{ label: 'Company EBITA', data: months.map((m) => m.ebita?.ebita ?? 0) }} />}
      table={<MonthTable ctx={ctx} caption="EBITA by month" rows={[{ label: 'Company EBITA', key: true, color: true, value: (idx) => sum(idx).ebita?.ebita ?? 0 }]} />} />
    <div className="seg-grid me-groups">
      {groups.map((g) => {
        const x = e.groups[g.key]
        const after = s.groups.find((y) => y.key === g.key)?.after_overhead ?? 0
        const grev = s.groups.find((y) => y.key === g.key)?.revenue ?? 0
        if (!x) return null
        return <div key={g.key} className="card">
          <div className="seg-hdr"><div className="seg-name"><span className="dot" style={{ background: g.color }} />{g.name}</div><StatusBadge margin={ratio(x.ebita, grev)} /></div>
          <div className="kpi4">
            <Kpi small label="After overhead" value={fk(after)} tone={tone(after)} />
            <Kpi small label="Own add-backs" value={fk(x.own)} />
            <Kpi small label="Share of corporate" value={fk(x.corporate)} />
            <Kpi small label="EBITA" value={fk(x.ebita)} tone={tone(x.ebita)} sub={pct(ratio(x.ebita, grev))} />
          </div></div>
      })}
    </div>
    <div className="card"><MonthTable ctx={ctx} caption="EBITA bridge by month" rows={[
      sec('Company'),
      { label: 'Net profit', color: true, value: (idx) => sum(idx).company.net_profit },
      ...shown.filter((k) => k !== 'depreciation').map((k) => ({ label: ADDBACK_LABEL[k], value: (idx: number[]) => sum(idx).ebita?.[k] ?? 0 })),
      { label: 'EBITA', key: true, color: true, value: (idx) => sum(idx).ebita?.ebita ?? 0 },
      { label: 'EBITA margin', pct: true, value: (idx) => { const x = sum(idx); return ratio(x.ebita?.ebita ?? 0, x.company.operating_revenue) } },
      ...(shown.includes('depreciation') ? [{ label: 'Depreciation, not added back', value: (idx: number[]) => sum(idx).ebita?.depreciation ?? 0 }] : []),
      sec('EBITA by group'),
      ...groups.map((g) => ({ label: g.name, color: true, value: (idx: number[]) => sum(idx).ebita?.groups[g.key]?.ebita ?? 0 })),
    ]} /></div>
  </>
}

// --------------------------------------------------------------------------------------------- Preview

function Preview({ ctx }: { ctx: Ctx }) {
  const t = useTokens()
  const { months } = ctx
  const month = months.at(-1)!
  const prior = months.length > 1 ? months[months.length - 2] : null
  const b = bridgeOf(month, prior)
  const name = monthName(month.month), priorName = prior ? monthShort(prior.month) : ''
  const adjustments = b.lines.reduce((a, l) => a + l.net, 0)
  const ops = b.groups.filter((g) => g.key !== 'overhead')
  return <>
    <div className="kpi-lg">
      <Kpi label="Net profit, GL as posted" value={fk(b.gl.net)} tone={tone(b.gl.net)} sub={`${fk(b.gl.revenue)} revenue`} />
      <Kpi label="Adjustments" value={fk(adjustments)} tone={tone(adjustments)} sub={`${b.lines.length} ${b.lines.length === 1 ? 'line' : 'lines'}`} />
      <Kpi label={`${name} pro forma net profit`} value={fk(b.proForma.net)} tone={tone(b.proForma.net)} sub={<>{pct(ratio(b.proForma.net, month.company.operating_revenue))} margin
        <Delta now={b.proForma.net} before={prior?.company.net_profit} label={priorName} /></>} />
      {prior && <Kpi label={`${priorName} net profit`} value={fk(prior.company.net_profit)} tone={tone(prior.company.net_profit)} sub={`${fk(prior.company.operating_revenue)} revenue`} />}
      {month.ebita && <Kpi label={`${name} pro forma EBITA`} value={fk(month.ebita.ebita)} tone={tone(month.ebita.ebita)} sub={<>{pct(ratio(month.ebita.ebita, month.company.operating_revenue))} margin
        <Delta now={month.ebita.ebita} before={prior?.ebita?.ebita} label={priorName} /></>} />}
    </div>
    <div className="card"><div className="ct"><span>From the GL to {name} pro forma</span></div>
      <div className="tw"><table className="pl bridge"><caption className="sr-only">From the GL to pro forma</caption>
        <thead><tr><th className="nosort" scope="col">Line</th><th className="nosort" scope="col">Revenue</th><th className="nosort" scope="col">Cost</th><th className="nosort" scope="col">Net profit</th></tr></thead>
        <tbody>
          <tr className="key"><th scope="row">{b.gl.label}</th><td>{money(b.gl.revenue)}</td><td>{money(b.gl.cost)}</td><td className={neg(b.gl.net)}>{money(b.gl.net)}</td></tr>
          {b.lines.map((l) => <tr key={l.key}><th scope="row" className="wrap">{l.label}</th><td>{l.revenue ? money(l.revenue) : '–'}</td><td>{l.cost ? money(l.cost) : '–'}</td><td className={neg(l.net)}>{l.net ? money(l.net) : '–'}</td></tr>)}
          <tr className="key tot"><th scope="row">{name} pro forma</th><td>{money(b.proForma.revenue)}</td><td>{money(b.proForma.cost)}</td><td className={neg(b.proForma.net)}>{money(b.proForma.net)}</td></tr>
        </tbody></table></div></div>
    <div className="charts2">
      <div className="card"><div className="ct"><span>By group, before corporate overhead</span></div>
        <div className="tw"><table className="pl bridge"><caption className="sr-only">Net before overhead by group</caption>
          <thead><tr><th className="nosort" scope="col">Group</th><th className="nosort" scope="col">Revenue</th><th className="nosort" scope="col">GL</th><th className="nosort" scope="col">Adjustments</th>
            <th className="nosort" scope="col">Pro forma</th>{prior && <th className="nosort" scope="col">{priorName}</th>}</tr></thead>
          <tbody>{b.groups.map((g) => <tr key={g.key}><th scope="row">{g.name}</th><td>{money(g.revenue)}</td><td className={neg(g.gl)}>{money(g.gl)}</td>
            <td className={neg(g.adjustments)}>{Math.abs(g.adjustments) < 0.5 ? '–' : money(g.adjustments)}</td><td className={neg(g.proForma)}><b>{money(g.proForma)}</b></td>
            {prior && <td className={neg(g.prior ?? 0)}>{money(g.prior)}</td>}</tr>)}
            <tr className="key tot"><th scope="row">Net profit</th><td>{money(month.company.operating_revenue)}</td><td className={neg(b.gl.net)}>{money(b.gl.net)}</td><td className={neg(adjustments)}>{money(adjustments)}</td>
              <td className={neg(b.proForma.net)}>{money(b.proForma.net)}</td>{prior && <td className={neg(prior.company.net_profit)}>{money(prior.company.net_profit)}</td>}</tr>
          </tbody></table></div></div>
      <ChartCard title={`Net before overhead by group: ${priorName ? `${priorName} against ` : ''}${monthShort(month.month)} pro forma`} height={280}
        legend={<>{prior && <Swatch color={t.accent2} label={priorName} />}<Swatch color={t.accent} label={`${monthShort(month.month)} pro forma`} /></>}
        chart={<GroupedMoneyChart labels={ops.map((g) => g.name)} ariaLabel="Net before overhead by group against the prior month"
          series={[...(prior ? [{ label: priorName, color: t.accent2, data: ops.map((g) => g.prior ?? 0) }] : []), { label: `${monthShort(month.month)} pro forma`, color: t.accent, data: ops.map((g) => g.proForma) }]} />}
        table={<table><thead><tr><th className="nosort l">Group</th>{prior && <th className="nosort">{priorName}</th>}<th className="nosort">Pro forma</th></tr></thead>
          <tbody>{ops.map((g) => <tr key={g.key}><td className="l">{g.name}</td>{prior && <td>{money(g.prior)}</td>}<td>{money(g.proForma)}</td></tr>)}</tbody></table>} />
    </div>
  </>
}
