import { useMemo, useState } from 'react'
import { useApiQuery } from '../hooks/useApiQuery'
import type { CompanyPlAccount, CompanyPlGroup, CompanyPlMonth, CompanyPlResponse } from '../services/apiTypes'
import { queryKey } from '../services/queryClient'
import { money, pct } from './format'
import { CATEGORY_LABEL, KIND_LABEL } from './pages/CompanyPlAdmin'
import { monthLabel, monthShort } from './routes'
import { useLeadership } from './state'
import { Kpi, LoadError, Skeleton, SortTable, type Column } from './ui'

const ratio = (a: number, b: number) => (b ? a / b : null)
const tone = (v: number) => (v < 0 ? 'bad' : '')
type Period = { key: string; label: string; months: CompanyPlMonth[] }

/** Sum months: every numeric field of the company block, groups and accounts. */
function combine(months: CompanyPlMonth[]): CompanyPlMonth {
  const add = <T extends object>(a: T, b: T): T => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === 'number' ? v + ((b as Record<string, unknown>)[k] as number ?? 0) : v])) as T
  const [first, ...rest] = months
  const out: CompanyPlMonth = JSON.parse(JSON.stringify(first))
  for (const m of rest) {
    out.company = add(out.company, m.company)
    out.overhead = add(out.overhead, m.overhead)
    out.groups = out.groups.map((g) => { const o = m.groups.find((x) => x.key === g.key); return o ? add(g, o) : g })
    for (const [slug, a] of Object.entries(m.accounts)) out.accounts[slug] = out.accounts[slug] ? add(out.accounts[slug], a) : { ...a }
    out.adjustments = [...out.adjustments, ...m.adjustments]
  }
  out.company.gross_margin = ratio(out.company.gross_profit, out.company.operating_revenue)
  out.company.net_margin = ratio(out.company.net_profit, out.company.revenue)
  out.company.overhead_pct = ratio(out.company.overhead, out.company.operating_revenue)
  out.groups = out.groups.map((g) => ({ ...g, margin: ratio(g.after_overhead, g.revenue), pool_share: ratio(g.pool_charge, out.overhead.pool) }))
  return out
}

/** The company P&L on Finance's basis: the Cross Tab Income Statement by job, the overhead rule and Finance's adjustments (app/company_pl.py). */
export function CompanyPl() {
  const { api, keyPrefix, decision, navigate } = useLeadership()
  const q = useApiQuery<CompanyPlResponse>(decision ? queryKey(`${keyPrefix}/leadership/company-pl`, { months: 12 }) : null, (signal) => api.companyPl(12, signal), [api])
  const months = q.data?.months ?? []
  const periods: Period[] = useMemo(() => {
    const last = months.at(-1)
    const year = last?.month.slice(0, 4)
    const ytd = months.filter((m) => m.month.startsWith(year ?? '-'))
    return [...[...months].reverse().map((m) => ({ key: m.month, label: monthLabel(m.month), months: [m] })),
      ...(ytd.length > 1 ? [{ key: 'ytd', label: `${year} year to date`, months: ytd }] : [])]
  }, [months])
  const [key, setKey] = useState<string | null>(null)
  if (q.error) return <LoadError error={q.error} onRetry={q.refetch} />
  if (!q.data) return <Skeleton height={300} />
  if (!months.length) return null
  const period = periods.find((p) => p.key === key) ?? periods[0]
  const m = period.months.length === 1 ? period.months[0] : combine(period.months)
  const c = m.company
  const accounts = Object.entries(m.accounts).map(([slug, a]) => ({ slug, ...a })).filter((a) => a.revenue || a.before_overhead)

  const groupCols: Column<CompanyPlGroup>[] = [
    { key: 'name', header: 'Group', left: true, value: (g) => g.name, className: 'nm' },
    { key: 'rev', header: 'Revenue', value: (g) => g.revenue, render: (g) => money(g.revenue) },
    { key: 'gp', header: 'Gross profit', value: (g) => g.gross_profit, render: (g) => <span className={tone(g.gross_profit)}>{money(g.gross_profit)}</span> },
    { key: 'bef', header: 'Before overhead', value: (g) => g.before_overhead, render: (g) => <span className={tone(g.before_overhead)}>{money(g.before_overhead)}</span> },
    { key: 'fix', header: 'Fixed charge', value: (g) => g.fixed_charge, render: (g) => money(-g.fixed_charge) },
    { key: 'staff', header: 'Direct staff', value: (g) => g.direct_staff, render: (g) => money(-g.direct_staff) },
    { key: 'pool', header: 'Pool share', value: (g) => g.pool_charge, render: (g) => <>{money(-g.pool_charge)}{g.pool_share != null && <span className="neutral"> {pct(g.pool_share)}</span>}</> },
    { key: 'aft', header: 'After overhead', value: (g) => g.after_overhead, render: (g) => <b className={tone(g.after_overhead)}>{money(g.after_overhead)}</b> },
    { key: 'mgn', header: 'Margin', value: (g) => g.margin, render: (g) => <span className="neutral">{pct(g.margin)}</span> },
  ]
  type AccountRow = CompanyPlAccount & { slug: string }
  const accountCols: Column<AccountRow>[] = [
    { key: 'name', header: 'Account', left: true, value: (a) => a.name, className: 'nm' },
    { key: 'rev', header: 'Revenue', value: (a) => a.revenue, render: (a) => money(a.revenue) },
    { key: 'lab', header: 'Direct labor', value: (a) => a.direct_labor, render: (a) => money(a.direct_labor) },
    { key: 'tax', header: 'Payroll taxes and ins.', value: (a) => a.payroll_taxes_insurance, render: (a) => money(a.payroll_taxes_insurance) },
    { key: 'sub', header: 'Subcontractors', value: (a) => a.subcontractors, render: (a) => money(a.subcontractors) },
    { key: 'gp', header: 'Gross profit', value: (a) => a.gross_profit, render: (a) => <span className={tone(a.gross_profit)}>{money(a.gross_profit)}</span> },
    { key: 'bef', header: 'Before overhead', value: (a) => a.before_overhead, render: (a) => <span className={tone(a.before_overhead)}>{money(a.before_overhead)}</span> },
    { key: 'bm', header: 'Margin', value: (a) => ratio(a.before_overhead, a.revenue), render: (a) => <span className="neutral">{pct(ratio(a.before_overhead, a.revenue))}</span> },
    { key: 'oh', header: 'Overhead', value: (a) => a.overhead, render: (a) => money(-a.overhead) },
    { key: 'aft', header: 'After overhead', value: (a) => a.after_overhead, render: (a) => <b className={tone(a.after_overhead)}>{money(a.after_overhead)}</b> },
    { key: 'am', header: 'Margin', value: (a) => ratio(a.after_overhead, a.revenue), render: (a) => <span className="neutral">{pct(ratio(a.after_overhead, a.revenue))}</span> },
  ]
  const line = (label: string, value: number, base: number | null, opts: { key?: boolean; sign?: -1 } = {}) => <tr className={opts.key ? 'tot' : ''}>
    <td className="l">{label}</td><td className={tone((opts.sign ?? 1) * value)}>{money((opts.sign ?? 1) * value)}</td><td className="neutral">{pct(base ? ((opts.sign ?? 1) * value) / base : null)}</td></tr>
  return <>
    <div className="sect-row"><h2 className="sect-h">Company P&amp;L</h2>
      <label className="field"><span className="sr-only">Period</span><select value={period.key} onChange={(e) => setKey(e.target.value)}>{periods.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></label></div>
    <div className="kpi-lg">
      <Kpi label="Revenue" value={money(c.revenue)} sub={period.label} />
      <Kpi label="Gross profit before overhead" value={money(c.gross_profit)} tone={tone(c.gross_profit)} sub={`${pct(c.gross_margin)} margin`} />
      <Kpi label="Corporate overhead" value={money(c.overhead)} sub={`${pct(c.overhead_pct)} of revenue`} />
      <Kpi label="Net profit" value={money(c.net_profit)} tone={tone(c.net_profit)} sub={`${pct(c.net_margin)} margin`} />
      <Kpi label="Adjustments" value={String(m.adjustments.length)} sub={m.adjustments.length ? money(m.adjustments.reduce((a, x) => a + x.effect, 0)) : undefined} />
    </div>
    <div className="charts2">
      <div className="card"><div className="ct"><span>Statement, {period.label}</span></div>
        <div className="tw"><table className="pl"><caption className="sr-only">Company statement</caption>
          <thead><tr><th className="nosort l">Line</th><th className="nosort">Amount</th><th className="nosort">% of revenue</th></tr></thead>
          <tbody>
            {line('Revenue', c.operating_revenue, c.operating_revenue, { key: true })}
            {line(CATEGORY_LABEL.direct_labor, c.direct_labor, c.operating_revenue, { sign: -1 })}
            {line(CATEGORY_LABEL.payroll_taxes_insurance, c.payroll_taxes_insurance, c.operating_revenue, { sign: -1 })}
            {line(CATEGORY_LABEL.subcontractors, c.subcontractors, c.operating_revenue, { sign: -1 })}
            {line(CATEGORY_LABEL.supplies, c.supplies, c.operating_revenue, { sign: -1 })}
            {c.other_direct !== 0 && line(CATEGORY_LABEL.other_direct, c.other_direct, c.operating_revenue, { sign: -1 })}
            {line('Gross profit', c.gross_profit, c.operating_revenue, { key: true })}
            {line('Operating expenses on the jobs', c.operating_expense, c.operating_revenue, { sign: -1 })}
            {line('Net before overhead', c.before_overhead, c.operating_revenue, { key: true })}
            {line('Corporate overhead', c.overhead, c.operating_revenue, { sign: -1 })}
            {line('Net profit', c.net_profit, c.revenue, { key: true })}
          </tbody></table></div></div>
      <div className="card"><div className="ct"><span>Corporate overhead, {period.label}</span></div>
        <div className="tw"><table><caption className="sr-only">Corporate overhead</caption><tbody>
          <tr><td className="l">Net cost of overhead jobs</td><td>{money(m.overhead.cost)}</td></tr>
          <tr><td className="l">Revenue on overhead jobs</td><td className="neutral">{money(m.overhead.revenue_on_overhead_jobs)}</td></tr>
          <tr><td className="l">Fixed charges</td><td>{money(m.overhead.fixed)}</td></tr>
          <tr><td className="l">Direct account staff</td><td>{money(m.overhead.direct_staff)}</td></tr>
          <tr className="tot"><td className="l">Pool spread by revenue</td><td>{money(m.overhead.pool)}</td></tr>
        </tbody></table></div></div>
    </div>
    <div className="card"><div className="ct"><span>Groups, {period.label}</span></div>
      <SortTable caption="Company P&L by group" rows={m.groups} columns={groupCols} defaultSort={{ key: 'rev', dir: -1 }} csvName="company-pl-groups" /></div>
    <div className="card"><div className="ct"><span>Accounts, {period.label}</span></div>
      <SortTable caption="Company P&L by account" rows={accounts} columns={accountCols} defaultSort={{ key: 'rev', dir: -1 }} csvName="company-pl-accounts"
        onRowClick={(a) => a.slug !== 'other' && navigate({ view: 'account', account: a.slug, tab: 'overview' })} rowLabel={(a) => `Open ${a.name}`} /></div>
    {m.adjustments.length > 0 && <div className="card"><div className="ct"><span>Adjustments, {period.label}</span></div>
      <div className="tw"><table><caption className="sr-only">Adjustments applied</caption>
        <thead><tr><th className="nosort l">Type</th><th className="nosort l">Line</th><th className="nosort">Amount</th><th className="nosort l">Description</th></tr></thead>
        <tbody>{m.adjustments.map((a, i) => <tr key={`${a.adjustment_id}-${i}`}><td className="l">{KIND_LABEL[a.kind]}{a.reversal ? ', reversal' : ''}</td><td className="l">{CATEGORY_LABEL[a.category]}</td>
          <td>{money(a.reversal ? -a.amount : a.amount)}</td><td className="l">{a.description}</td></tr>)}</tbody></table></div></div>}
    <p className="foot neutral">Cross Tab Income Statement by job: {q.data.loaded.map((l) => `${monthShort(l.month)}${l.loaded_at ? ` loaded ${l.loaded_at.slice(0, 10)}` : ''}`).join(', ')}</p>
  </>
}
