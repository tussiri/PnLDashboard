import { useMemo } from 'react'
import type { BudgetMonth, BudgetWeek, LeadershipAccount, LeadershipRow } from '../services/apiTypes'
import { rowsOfWeek, segmentOrder, useGlProfit, useRows, weekBudgetOf } from './data'
import { money, pct } from './format'
import { accountSummary, type MetricOptions } from './metrics'
import { addDays, monthShort, weekEndOf } from './routes'
import { Kpi } from './ui'

/** Weeks per rows request (the API's maximum). */
const LOAD = 26

export interface FiscalTotals { start: string; label: string; weeks: number; revenue: number; labor: number; plan: number | null
  /** The first week counted (its start), null when none. */
  first: string | null
  /** Vendor (Amazon: agency) cost inside `labor`, OT cost and OT hours. */
  vendor: number; otDollars: number; otHours: number
  /** Group invoicing at each group's target, summed, and the group invoicing it was taken on: their ratio is the invoicing-weighted target. */
  targetInvoice: number; groupInvoice: number }

/** The fiscal year holding a week: July to June for school districts (FY27 = Jul 2026 to Jun 2027), else the calendar year. */
export function fiscalYearOf(weekEnd: string, startMonth: number): { start: string; label: string } {
  const y = Number(weekEnd.slice(0, 4)), m = Number(weekEnd.slice(5, 7))
  const year = m >= startMonth ? y : y - 1
  return { start: `${year}-${String(startMonth).padStart(2, '0')}-01`, label: startMonth === 1 ? String(year) : `FY${String((year + 1) % 100).padStart(2, '0')}` }
}

/**
 * Fiscal year to date through the selected week, from the weekly rows: invoicing and labor (the account
 * rollup, non-billed events excluded) and the weekly budget labor. A week that starts before the fiscal
 * year counts only its days inside it.
 */
export function fiscalTotals(rows: LeadershipRow[], weeks: string[], through: string, startMonth: number, options: MetricOptions, order: string[],
  budget: (weekStart: string) => number | null): FiscalTotals {
  const fy = fiscalYearOf(weekEndOf(through), startMonth)
  let revenue = 0, labor = 0, plan = 0, planned = false, n = 0, vendor = 0, otDollars = 0, otHours = 0, targetInvoice = 0, groupInvoice = 0
  let first: string | null = null
  for (const wk of weeks) {
    if (wk > through || weekEndOf(wk) < fy.start) continue
    const days = wk >= fy.start ? 7 : Math.round((Date.parse(`${weekEndOf(wk)}T00:00:00Z`) - Date.parse(`${fy.start}T00:00:00Z`)) / 86_400_000) + 1
    const share = days / 7
    const wr = rowsOfWeek(rows, wk)
    if (!wr.length) continue
    const summary = accountSummary(wr, options, order)
    const s = summary.account
    revenue += s.invoice * share; labor += s.cost * share; n += 1
    vendor += s.vendor * share; otDollars += s.otDollars * share; otHours += s.otHours * share
    for (const g of summary.segments) { targetInvoice += g.rollup.invoice * g.target * share; groupInvoice += g.rollup.invoice * share }
    if (first == null || wk < first) first = wk
    const b = budget(wk)
    if (b != null) { plan += b * share; planned = true }
  }
  return { ...fy, weeks: n, revenue, labor, plan: planned ? plan : null, first, vendor, otDollars, otHours, targetInvoice, groupInvoice }
}

/** Fiscal year to date through the selected week; null until the rows load. */
export function useFiscalTotals(account: LeadershipAccount, options: MetricOptions, weekStart: string, startMonth: number,
  budgetWeeks?: BudgetWeek[], budgetMonths?: BudgetMonth[], payHolidays = false): FiscalTotals | null {
  const fy = fiscalYearOf(weekEndOf(weekStart), startMonth)
  const recent = useRows(account.slug, LOAD)
  const olderStart = addDays(weekStart, -LOAD * 7)
  const older = useRows(weekEndOf(olderStart) >= fy.start ? account.slug : undefined, LOAD, { week: olderStart })
  const t = useMemo(() => {
    const rows = [...(older.data?.rows ?? []), ...(recent.data?.rows ?? [])]
    const weeks = [...new Set([...(older.data?.weeks ?? []), ...(recent.data?.weeks ?? [])])].sort()
    return fiscalTotals(rows, weeks, weekStart, startMonth, options, segmentOrder(account),
      (wk) => weekBudgetOf(wk, budgetWeeks, budgetMonths, payHolidays)?.labor ?? null)
  }, [older.data, recent.data, weekStart, startMonth, options, account, budgetWeeks, budgetMonths, payHolidays])
  return recent.data ? t : null
}

/** The CDO dashboards' headline: fiscal year to date revenue less labor, with revenue, labor and plan labor. */
export function FiscalHero({ account, options, weekStart, startMonth, budgetWeeks, budgetMonths, payHolidays }: { account: LeadershipAccount; options: MetricOptions; weekStart: string; startMonth: number
  budgetWeeks?: BudgetWeek[]; budgetMonths?: BudgetMonth[]; payHolidays: boolean }) {
  const t = useFiscalTotals(account, options, weekStart, startMonth, budgetWeeks, budgetMonths, payHolidays)
  const fy = fiscalYearOf(weekEndOf(weekStart), startMonth)
  const gl = useGlProfit(account.slug, fy.start)
  if (!t || !t.weeks) return null
  const net = t.revenue - t.labor
  const span = `${monthShort(t.start)} 1 to ${monthShort(weekEndOf(weekStart))} ${Number(weekEndOf(weekStart).slice(8, 10))}`
  const vsPlan = t.plan != null ? t.labor - t.plan : null
  // With the account's GL income statement loaded for the fiscal year, the headline is its net profit (Finance's basis).
  const glMonths = (gl.data?.months ?? []).filter((m) => m.month <= weekEndOf(weekStart))
  const glLast = glMonths.at(-1)
  const glNet = glMonths.reduce((a, m) => a + m.adjusted_net_profit, 0)
  const main = glLast
    ? <div className="hero__main">
      <div className="kl">{t.label} net profit to date (GL, {monthShort(glMonths[0].month)} to {monthShort(glLast.month)})</div>
      <div className={`hero__v ${glNet < 0 ? 'bad' : 'ok'}`}>{money(glNet)}</div>
      <div className="ks">{monthShort(glLast.month)} {money(glLast.adjusted_net_profit)}</div>
    </div>
    : <div className="hero__main">
      <div className="kl">{t.label} to date: revenue less labor ({span})</div>
      <div className={`hero__v ${net < 0 ? 'bad' : 'ok'}`}>{money(net)}</div>
      <div className="ks">{t.weeks} weeks · labor {pct(t.revenue > 0 ? t.labor / t.revenue : null)} of revenue</div>
    </div>
  const glTip = glLast ? `GL net profit${glMonths.some((m) => m.workers_comp_added) ? `, workers' comp at ${pct(gl.data!.workers_comp_rate)} of wages where not posted` : ''}${glMonths.some((m) => m.adjustments) ? ', Finance adjustments applied' : ''}` : "Revenue less direct labor only: payroll taxes, workers' comp, supplies, equipment and overhead are not included, so this is not net profit."
  const shown = glLast ? glNet : net
  return <div className={`hero${shown < 0 ? ' neg' : ''}`} title={glTip}>
    {main}
    {glLast && <Kpi small label={`Revenue less labor (${span})`} value={money(net)} tone={net < 0 ? 'bad' : 'ok'} tip={`${t.weeks} weeks of weekly invoicing less weekly labor`} />}
    <Kpi small label="Revenue (est.)" value={money(t.revenue)} tip={`Weekly invoicing summed over ${t.weeks} weeks`} />
    <Kpi small label="Labor" value={money(t.labor)} tip="Weekly labor, non-billed events excluded" />
    {t.plan != null && <Kpi small label="Plan labor" value={money(t.plan)} tip={`Plan margin ${money(t.revenue - t.plan)}`} />}
    {vsPlan != null && <Kpi small label="Labor vs plan" value={`${vsPlan >= 0 ? '+' : '−'}${money(Math.abs(vsPlan))}`} tone={vsPlan > 0 ? 'bad' : 'ok'} tip={vsPlan > 0 ? 'Over plan to date' : 'Under plan to date'} />}
  </div>
}
