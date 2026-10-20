import { describe, expect, it } from 'vitest'
import type { LeadershipRow } from '../services/apiTypes'
import { fiscalTotals, fiscalYearOf } from './FiscalHero'

const row = (week_start: string, labor: number): LeadershipRow => ({
  week_start, week_end: '', company: 'C', job_number: '1', site_name: 'S', account_slug: 'plano-isd', segment: 'A', role: 'site', hours: 10, ot_hours: 0, labor,
  ot_dollars: 0, budget_hours: 0, budget_dollars: 0, revenue_month_amount: 4330, prior_revenue: 0, prior_labor: 0, prior_sub: 0,
} as unknown as LeadershipRow)

describe('fiscal year to date', () => {
  it('names the school fiscal year by its end year and the calendar year otherwise', () => {
    expect(fiscalYearOf('2026-10-18', 7)).toEqual({ start: '2026-07-01', label: 'FY27' })
    expect(fiscalYearOf('2027-03-07', 7)).toEqual({ start: '2026-07-01', label: 'FY27' })
    expect(fiscalYearOf('2026-10-18', 1)).toEqual({ start: '2026-01-01', label: '2026' })
  })

  it('sums the weeks since the start, counting a straddling week by its days inside the year', () => {
    // Weeks start Monday: Jun 29 to Jul 5 has 5 days in FY27 (Jul 1 to 5); Jun 22 is before it.
    const weeks = ['2026-06-22', '2026-06-29', '2026-07-06', '2026-07-13']
    const rows = weeks.map((w) => row(w, 700))
    const t = fiscalTotals(rows, weeks, '2026-07-06', 7, { target: 0.5 }, [], (wk) => (wk === '2026-07-06' ? 600 : null))
    expect(t.weeks).toBe(2)
    expect(t.revenue).toBeCloseTo(1000 * (5 / 7 + 1), 6) // $4,330 a month ÷ 4.33
    expect(t.labor).toBeCloseTo(700 * (5 / 7 + 1), 6)
    expect(t.plan).toBeCloseTo(600, 6)
  })
})
