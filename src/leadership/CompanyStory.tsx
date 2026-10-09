import { useState, type CSSProperties, type ReactNode } from 'react'
import type { BudgetMonth, CompanyMonth } from '../services/apiTypes'
import type { GlossaryKey } from './glossary'
import { hours, money, moneyK, pct } from './format'
import { useRevealOnce } from './reveal'
import { monthLabel, monthShort, weekRange } from './routes'
import { MetricLabel, MonthBars, SquareGrid, StoryBars, StoryLine, type SquareGroup } from './storyCharts'
import {
  accountsStory, allocationsStory, per100, planStory, revenueStory, storyWindow, weekStory,
  type Per100Key, type PlanStory, type WeekLine,
} from './storyMetrics'
import { Empty, Swatch } from './ui'

interface Figure {
  metric: GlossaryKey
  /** Shorter than the glossary term where the row needs it. */
  label?: string
  value: string
  /** The counts behind the value: "3 of 7 accounts". */
  detail?: string
  tone?: string
}

/**
 * One story section as one card, read top to bottom: title and period, the figures it is about, the chart
 * that shows them (or its table), and a line on how they are counted.
 */
function Section({ id, title, subtitle, figures, chart, table, legend, note, wide }: {
  id: string; title: string; subtitle: string; figures: Figure[]; chart: ReactNode; table?: ReactNode; legend?: ReactNode; note?: ReactNode; wide?: boolean
}) {
  const [ref, phase] = useRevealOnce<HTMLElement>(`company-${id}`)
  const [asTable, setAsTable] = useState(false)
  return <section ref={ref} id={`story-${id}`} data-reveal={phase} aria-labelledby={`story-${id}-t`} className={wide ? 'wide' : undefined}>
    <div className="card story-card">
      <header className="story-h">
        <div><h3 id={`story-${id}-t`}>{title}</h3><p>{subtitle}</p></div>
        {table && <button type="button" className="linkbtn" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>{asTable ? 'Chart' : 'Table'}</button>}
      </header>
      <dl className="story-figs">
        {figures.map((f, i) => <div key={f.metric + (f.label ?? '')} className="story-stat" style={{ '--story-delay': `${i * 60}ms` } as CSSProperties}>
          <dt><MetricLabel metric={f.metric} label={f.label} /></dt>
          <dd className={`sv ${f.tone ?? ''}`}>{f.value}</dd>
          {f.detail ? <dd className="sd">{f.detail}</dd> : null}
        </div>)}
      </dl>
      <div className="story-chart">
        {asTable && table ? <div className="tw">{table}</div> : <>{legend && <div className="legend">{legend}</div>}{chart}</>}
      </div>
      {note ? <p className="story-note">{note}</p> : null}
    </div>
  </section>
}

const PER100_COLORS: Record<Per100Key, string> = {
  labor: 'var(--s1)', subcontractors: 'var(--s2)', taxes: 'var(--s3)', other: 'var(--muted)', profit: 'var(--ok)',
}
/** Short dollars for axes, bar ends and end labels, negatives in parentheses as `money` writes them: "$0", "$840K", "($1.2M)". */
export const compact = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return money(v)
  if (v === 0) return '$0'
  const a = Math.abs(v)
  const body = a >= 1_000_000 ? `$${(a / 1_000_000).toFixed(1)}M` : moneyK(a)
  return v < 0 ? `(${body})` : body
}
const signed = (v: number | null) => (v == null ? pct(v) : `${v >= 0 ? '+' : '-'}${pct(Math.abs(v))}`)
const of = (part: number, whole: number, unit: string) => `${part.toLocaleString('en-US')} of ${whole.toLocaleString('en-US')} ${unit}`
const span = (from: string | null, to: string | null) => (from && to ? `${monthLabel(from)} to ${monthLabel(to)}` : '')

export interface CompanyStoryProps {
  /** /leadership/company months, oldest first, ending with the last month the job cost covers. */
  months: CompanyMonth[]
  accountNames: Record<string, string>
  /** The featured accounts in the selected week (by default the last complete week). */
  week: { start: string | undefined; lines: WeekLine[]; loading: boolean }
  /** Labor budgets of the featured accounts; null while loading or when the user cannot see budgets. */
  budgets: { slug: string; months: BudgetMonth[] }[] | null
  /** The budgets are still loading: the last card waits rather than drawing the fallback and swapping it. */
  budgetsLoading?: boolean
}

/**
 * The Company page's "At a glance" story: five cards, revenue full width, the rest paired on wide screens and
 * stacked on narrow ones. Every window ends with the last month the job cost covers.
 */
export function CompanyStory({ months, accountNames, week, budgets, budgetsLoading }: CompanyStoryProps) {
  const w = storyWindow(months)
  const rev = revenueStory(w)
  const split = per100(w.closed)
  const accts = accountsStory(w.closed, accountNames)
  const wk = weekStory(week.lines)
  const plan = budgets ? planStory(budgets, w.months.map((m) => m.month)) : null
  const alloc = allocationsStory(w.closed)
  const range = span(w.from, w.through)
  const closedNote = rev.openMonths.length ? `Closed months only; ${rev.openMonths.map(monthShort).join(', ')} not closed and not counted.` : 'Closed months only.'
  const flagged = rev.flagged.length
    ? ` ${rev.flagged.map((f) => monthLabel(f.month)).join(', ')}: ${rev.flagged.some((f) => f.flags.includes('sub_spike')) ? 'subcontractor' : 'direct labor'} cost well above other months, included.`
    : ''

  return <div className="story">
    <Section id="revenue" wide title="Revenue" subtitle={`Revenue by month, ${range}`}
      figures={[
        { metric: 'storyRevenue', value: money(rev.revenue), detail: `${rev.closedMonths} closed months${rev.yearToDate && rev.yearToDate.months < rev.closedMonths ? `; ${compact(rev.yearToDate.revenue)} in ${rev.yearToDate.year}` : ''}` },
        { metric: 'storyRevenueTrend', value: signed(rev.trend?.change ?? null), tone: rev.trend?.change == null ? '' : rev.trend.change < 0 ? 'bad' : 'ok',
          detail: rev.trend ? `${monthShort(rev.trend.recentFrom)} to ${monthShort(rev.trend.recentTo)} against the 3 before` : 'Needs 6 closed months' },
        { metric: 'storyGrossMargin', value: pct(rev.margin), detail: rev.grossProfit == null ? undefined : `${money(rev.grossProfit)} gross profit` },
        { metric: 'storyLaborPct', value: pct(rev.laborPct), detail: 'Direct labor of revenue' },
      ]}
      legend={<><Swatch color="var(--accent)" label="Closed" /><Swatch color="var(--muted)" label="Not closed" /></>}
      chart={w.months.some((m) => m.revenue > 0)
        ? <MonthBars caption="Revenue by month; months not yet closed in a muted color." format={compact}
            bars={w.months.map((m) => ({ key: m.month, label: monthShort(m.month), value: m.revenue, muted: !m.closed,
              tip: <><b>{monthLabel(m.month)}{m.closed ? '' : ', not closed'}</b><span>Revenue {money(m.revenue)}</span><span>Gross profit {money(m.gross_profit)}</span></> }))} />
        : <Empty>No revenue in this window.</Empty>}
      table={<table><thead><tr><th className="nosort l">Month</th><th className="nosort">Revenue</th><th className="nosort">Gross profit</th><th className="nosort">Margin</th><th className="nosort">Labor %</th></tr></thead>
        <tbody>{w.months.map((m) => <tr key={m.month}><td className="l">{monthLabel(m.month)}{m.closed ? '' : ' (not closed)'}</td><td>{money(m.revenue)}</td><td>{money(m.gross_profit)}</td>
          <td>{pct(m.revenue > 0 ? m.gross_profit / m.revenue : null)}</td><td>{pct(m.revenue > 0 ? m.direct_labor / m.revenue : null)}</td></tr>)}</tbody></table>}
      note={closedNote} />

    <Section id="per100" title="Every $100 billed" subtitle={`Where closed-month revenue went, ${range}`}
      figures={split ? [
        { metric: 'storyPer100', label: 'Direct labor', value: `$${split.parts.find((p) => p.key === 'labor')!.squares}`, detail: 'Of every $100' },
        { metric: 'storyPer100', label: 'Gross profit', value: `$${split.parts.find((p) => p.key === 'profit')!.squares}`, detail: 'Of every $100' },
      ] : [{ metric: 'storyPer100', value: pct(null), detail: 'Not yet knowable' }]}
      chart={split
        ? <SquareGrid caption="Every $100 of revenue, one square per dollar"
            groups={split.parts.map((p): SquareGroup => ({ key: p.key, label: p.label, squares: p.squares, color: PER100_COLORS[p.key], detail: money(p.amount) }))} />
        : <Empty>Not drawn: costs exceed or do not reconcile to revenue.</Empty>}
      table={split ? <table><thead><tr><th className="nosort l">Line</th><th className="nosort">Amount</th><th className="nosort">Of $100</th></tr></thead>
        <tbody>{split.parts.map((p) => <tr key={p.key}><td className="l">{p.label}</td><td>{money(p.amount)}</td><td>${p.squares}</td></tr>)}</tbody></table> : undefined}
      note={`Rounded to whole dollars that sum to 100.${split?.missing.length ? ` Not in the job cost: ${split.missing.join(', ').toLowerCase()}.` : ''}${flagged}`} />

    <Section id="accounts" title="Accounts" subtitle={`Closed-month revenue by account, ${range}`}
      figures={[
        { metric: 'storyAccountShare', value: pct(accts.top?.share), detail: accts.top ? accts.top.name : undefined },
        { metric: 'storyAccountMargin', value: accts.top ? String(accts.losingRecently) : pct(null), tone: accts.losingRecently ? 'bad' : '',
          detail: `${of(accts.losingRecently, accts.rows.filter((r) => r.slug !== 'other').length, 'accounts')}${accts.recentFrom ? `, ${monthShort(accts.recentFrom)} to ${monthShort(accts.recentTo)}` : ''}` },
      ]}
      chart={accts.rows.length
        ? <StoryBars caption="Revenue by account, with gross margin." rows={accts.rows.map((r, i) => ({
            key: r.slug, label: r.name, value: r.revenue, display: compact(r.revenue), detail: `${pct(r.margin)}; last 3 ${pct(r.recentMargin)}`,
            tone: r.grossProfit < 0 || r.recentProfit < 0 ? 'bad' : r.slug === 'other' ? 'sbar-muted' : i === 0 ? 'sbar' : 'sbar-muted',
            tip: `${r.name}: revenue ${money(r.revenue)}, ${pct(r.share)} of the total; gross profit ${money(r.grossProfit)}, ${money(r.recentProfit)} in the latest 3 closed months` }))} />
        : <Empty>No account revenue in this window.</Empty>}
      table={<table><thead><tr><th className="nosort l">Account</th><th className="nosort">Revenue</th><th className="nosort">Share</th><th className="nosort">Gross profit</th><th className="nosort">Margin</th><th className="nosort">Margin, last 3 months</th></tr></thead>
        <tbody>{accts.rows.map((r) => <tr key={r.slug}><td className="l">{r.name}</td><td>{money(r.revenue)}</td><td>{pct(r.share)}</td><td>{money(r.grossProfit)}</td><td>{pct(r.margin)}</td><td>{pct(r.recentMargin)}</td></tr>)}</tbody></table>}
      note={`Margin over the 12 months, then over the latest 3 closed months; red when either is a loss. Accounts not featured count together as Other accounts.`} />

    <Section id="week" title="This week" subtitle={week.start ? `Labor % against target, ${weekRange(week.start)}` : 'Labor % against target'}
      figures={[
        { metric: 'storyOverTarget', value: wk.rated ? String(wk.over) : pct(null), tone: wk.over ? 'bad' : wk.rated ? 'ok' : '',
          detail: wk.rated ? `${of(wk.over, wk.rated, 'accounts')}; ${wk.watch} watch` : 'No account billed yet' },
        { metric: 'storyHoursOver', value: hours(wk.overHours), detail: 'Hours to cut' },
      ]}
      legend={<><Swatch color="var(--ok)" label="On target" /><Swatch color="var(--warn)" label="Watch" /><Swatch color="var(--bad)" label="Over" /><Swatch label="Target" line /></>}
      chart={week.loading ? <div className="skel" style={{ height: 160 }} aria-hidden="true" /> : wk.rated
        ? <StoryBars caption="Labor % of each featured account this week, with its target." rows={wk.rows.map((r) => ({
            key: r.slug, label: r.name, value: r.laborPct!, display: pct(r.laborPct), detail: `target ${pct(r.target)}`, marker: r.target,
            tone: r.status === 'over' ? 'bad' : r.status === 'watch' ? 'warn' : 'ok',
            tip: `${r.name}: labor ${pct(r.laborPct)} against ${pct(r.target)}; ${hours(r.overHours)} hours over target` }))} />
        : <Empty>No billing this week.</Empty>}
      table={<table><thead><tr><th className="nosort l">Account</th><th className="nosort">Labor %</th><th className="nosort">Target</th><th className="nosort">Hours over</th></tr></thead>
        <tbody>{wk.rows.map((r) => <tr key={r.slug}><td className="l">{r.name}</td><td>{pct(r.laborPct)}</td><td>{pct(r.target)}</td><td>{hours(r.overHours)}</td></tr>)}</tbody></table>}
      note={`Featured accounts with billing that week${wk.noData ? `; ${wk.noData} without` : ''}. Labor from the Pay Report, else payroll rates, else a trailing-rate estimate.`} />

    {budgetsLoading ? <div className="card story-card"><div className="skel" style={{ height: 320 }} aria-hidden="true" /></div> : plan ? <PlanSection plan={plan} /> : alloc ? <Section id="plan" title="After allocations" subtitle={`Gross profit less allocations by month, ${range}`}
      figures={[
        { metric: 'storyAfterAllocations', value: money(alloc.after), tone: alloc.after < 0 ? 'bad' : '', detail: `${compact(alloc.allocated)} allocated` },
        { metric: 'storyAfterAllocationsShare', value: pct(alloc.share), detail: 'Of revenue' },
      ]}
      legend={<><Swatch color="var(--accent)" label="After allocations" /><Swatch color="var(--muted)" label="Gross profit" /></>}
      chart={<StoryLine caption="Gross profit after allocations by closed month, over gross profit." format={compact}
        endLabel={compact(alloc.months.at(-1)!.after)}
        points={alloc.months.map((m) => ({ key: m.month, label: monthShort(m.month), value: m.after, band: m.grossProfit,
          tip: <><b>{monthLabel(m.month)}</b><span>Gross profit {money(m.grossProfit)}</span><span>Allocated {money(m.allocated)}</span><span>After {money(m.after)}</span></> }))} />}
      table={<table><thead><tr><th className="nosort l">Month</th><th className="nosort">Gross profit</th><th className="nosort">Allocated</th><th className="nosort">After allocations</th></tr></thead>
        <tbody>{alloc.months.map((m) => <tr key={m.month}><td className="l">{monthLabel(m.month)}</td><td>{money(m.grossProfit)}</td><td>{money(m.allocated)}</td><td>{money(m.after)}</td></tr>)}</tbody></table>}
      note={budgets ? 'No account has a labor budget for two finished months in this window.' : 'Closed months only.'} />
      : <Section id="plan" title="Against plan" subtitle={range} figures={[{ metric: 'storyPlanVariance', value: pct(null), detail: 'Not yet knowable' }]}
          chart={<Empty>No labor budgets or allocations for this window.</Empty>} />}
  </div>
}

function PlanSection({ plan }: { plan: PlanStory }) {
  const lastVar = plan.last.budget > 0 ? plan.last.actual / plan.last.budget - 1 : null
  return <Section id="plan" title="Against plan" subtitle={`Labor against budget by month, ${monthLabel(plan.months[0].month)} to ${monthLabel(plan.last.month)}`}
    figures={[
      { metric: 'storyPlanVariance', value: signed(plan.variancePct), tone: plan.variancePct == null ? '' : plan.variancePct > 0 ? 'bad' : 'ok',
        detail: `${compact(plan.actual)} against ${compact(plan.budget)}` },
      { metric: 'storyPlanVariance', label: monthLabel(plan.last.month), value: signed(lastVar), tone: lastVar == null ? '' : lastVar > 0 ? 'bad' : 'ok',
        detail: `${plan.last.accounts} accounts` },
      { metric: 'storyPlanAccounts', label: 'Accounts', value: String(plan.accounts), detail: 'With a labor budget' },
    ]}
    legend={<><Swatch color="var(--accent)" label="Actual labor" /><Swatch color="var(--muted)" label="Budget" /></>}
    chart={<StoryLine caption="Labor by month against the summed labor budgets of the same accounts." format={compact}
      endLabel={`${signed(lastVar)} against budget`}
      points={plan.months.map((m) => ({ key: m.month, label: monthShort(m.month), value: m.actual, band: m.budget,
        tip: <><b>{monthLabel(m.month)}</b><span>Actual {money(m.actual)}</span><span>Budget {money(m.budget)}</span><span>{m.accounts} accounts</span></> }))} />}
    table={<table><thead><tr><th className="nosort l">Month</th><th className="nosort">Actual</th><th className="nosort">Budget</th><th className="nosort">Variance</th><th className="nosort">Accounts</th></tr></thead>
      <tbody>{plan.months.map((m) => <tr key={m.month}><td className="l">{monthLabel(m.month)}</td><td>{money(m.actual)}</td><td>{money(m.budget)}</td>
        <td>{signed(m.budget > 0 ? m.actual / m.budget - 1 : null)}</td><td>{m.accounts}</td></tr>)}</tbody></table>}
    note="Each month counts the accounts with both a budget and a finished month; actual is job cost when closed, else timekeeping." />
}
