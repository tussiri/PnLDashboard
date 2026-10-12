import { describe, expect, it } from 'vitest'
import { accountSummary, type MetricOptions, type WeekRow } from './metrics'
import { compareGroups, compareSites, delta, moneyChange, pctChange } from './monthCompare'

type Row = WeekRow & { company: string | null }
const opts: MetricOptions = { target: 0.6, revenueMethod: 'weekly_billing', period: 'month', periodDays: 30 }
const row = (job: string, segment: string, labor: number, invoice: number, extra: Partial<Row> = {}): Row => ({
  company: 'Crane IFS', job_number: job, site_name: `Site ${job}`, segment, role: 'site', revenue_month_amount: 0, invoice_week: invoice,
  labor, hours: labor / 20, ot_hours: 0, ot_dollars: 0, budget_hours: 0, budget_dollars: 0, prior_revenue: 0, prior_labor: 0, prior_sub: 0, ...extra,
})

describe('month against month', () => {
  it('computes the change in dollars and percent of the comparison month', () => {
    expect(delta(110, 100)).toEqual({ cur: 110, cmp: 100, diff: 10, pct: 0.1 })
    expect(delta(90, null)).toEqual({ cur: 90, cmp: null, diff: null, pct: null })
    expect(delta(50, 0).pct).toBeNull()
    expect(delta(-50, -100).pct).toBeCloseTo(0.5)
    expect(moneyChange(-1234.4)).toBe('−$1,234')
    expect(moneyChange(1234.6)).toBe('+$1,235')
    expect(pctChange(0.042)).toBe('+4.2%')
    expect(pctChange(null)).toBe('–')
  })

  it('pairs sites by company and job, keeping sites found in only one month', () => {
    const sep = accountSummary([row('801', 'Elementary', 6000, 10000), row('802', 'High', 3000, 5000), row('900', 'Elementary', 500, 0, { role: 'non_billed' })], opts)
    const aug = accountSummary([row('801', 'Elementary', 5000, 10000), row('803', 'High', 2000, 4000), row('802', 'High', 3000, 5000, { company: 'Sarus' })], opts)
    const sites = compareSites(sep.sites, aug.sites)
    expect(sites.map((s) => s.key)).toEqual(['Crane IFS|801', 'Crane IFS|802', 'Crane IFS|803', 'Sarus|802'])
    const s801 = sites[0]
    expect(s801.cost).toEqual({ cur: 6000, cmp: 5000, diff: 1000, pct: 0.2 })
    expect(s801.measurePct.diff).toBeCloseTo(0.1)
    expect(sites[1].cost.cmp).toBeNull()
    expect(sites[2].cost.cur).toBeNull()
    expect(sites[2].cost.cmp).toBe(2000)
  })

  it('compares each group', () => {
    const sep = accountSummary([row('801', 'Elementary', 6000, 10000), row('802', 'High', 3000, 5000)], opts, ['Elementary', 'High'])
    const aug = accountSummary([row('801', 'Elementary', 5000, 10000)], opts, ['Elementary', 'High'])
    const groups = compareGroups(sep, aug)
    expect(groups.map((g) => g.name)).toEqual(['Elementary', 'High'])
    expect(groups[0].cost.diff).toBe(1000)
    expect(groups[1].cost).toEqual({ cur: 3000, cmp: null, diff: null, pct: null })
  })
})
