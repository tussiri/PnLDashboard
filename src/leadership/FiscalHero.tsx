import { useMemo } from 'react'
import type { BudgetMonth, BudgetWeek, LeadershipAccount, LeadershipRow } from '../services/apiTypes'
import { rowsOfWeek, segmentOrder, useRows, weekBudgetOf } from './data'
import { money, pct } from './format'
import { accountSummary, type MetricOptions } from './metrics'
import { addDays, monthShort, weekEndOf } from './routes'
import { Kpi } from './ui'

/** Weeks per rows request (the API's maximum). */
const LOAD = 26

export interface FiscalTotals { start: string; label: string; weeks: number; revenue: number; labor: number; plan: number | null }

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
  let revenue = 0, labor = 0, plan = 0, planned = false, n = 0
  for (const wk of weeks) {
    if (wk > through || weekEndOf(wk) < fy.start) continue
    const days = wk >= fy.start ? 7 : Math.round((Date.parse(`${weekEndOf(wk)}T00:00:00Z`) - Date.parse(`${fy.start}T00:00:00Z`)) / 86_400_000) + 1
    const share = days / 7
    const wr = rowsOfWeek(rows, wk)
    if (!wr.length) continue
    const s = accountSummary(wr, options, order).account
    revenue += s.invoice * share; labor += s.cost * share; n += 1
    const b = budget(wk)
    if (b != null) { plan += b * share; planned = true }
  }
  return { ...fy, weeks: n, revenue, labor, plan: planned ? plan : null }
}

/** The CDO dashboards' headline: fiscal year to date revenue less labor, with revenue, labor and plan labor. */
export function FiscalHero({ account, options, weekStart, startMonth, budgetWeeks, budgetMonths, payHolidays }: { account: LeadershipAccount; options: MetricOptions; weekStart: string; startMonth: number
  budgetWeeks?: BudgetWeek[]; budgetMonths?: BudgetMonth[]; payHolidays: boolean }) {
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
  if (!recent.data || !t.weeks) return null
  const net = t.revenue - t.labor
  const span = `${monthShort(t.start)} 1 to ${monthShort(weekEndOf(weekStart))} ${Number(weekEndOf(weekStart).slice(8, 10))}`
  const vsPlan = t.plan != null ? t.labor - t.plan : null
  return <div className={`hero${net < 0 ? ' neg' : ''}`} title="Revenue less direct labor only: payroll taxes, workers' comp, supplies, equipment and overhead are not included, so this is not net profit.">
    <div className="hero__main">
      <div className="kl">{t.label} to date: revenue less labor ({span})</div>
      <div className={`hero__v ${net < 0 ? 'bad' : 'ok'}`}>{money(net)}</div>
      <div className="ks">{t.weeks} weeks · labor {pct(t.revenue > 0 ? t.labor / t.revenue : null)} of revenue</div>
    </div>
    <Kpi small label="Revenue (est.)" value={money(t.revenue)} tip={`Weekly invoicing summed over ${t.weeks} weeks`} />
    <Kpi small label="Labor" value={money(t.labor)} tip="Weekly labor, non-billed events excluded" />
    {t.plan != null && <Kpi small label="Plan labor" value={money(t.plan)} tip={`Plan margin ${money(t.revenue - t.plan)}`} />}
    {vsPlan != null && <Kpi small label="Labor vs plan" value={`${vsPlan >= 0 ? '+' : '−'}${money(Math.abs(vsPlan))}`} tone={vsPlan > 0 ? 'bad' : 'ok'} tip={vsPlan > 0 ? 'Over plan to date' : 'Under plan to date'} />}
  </div>
}
