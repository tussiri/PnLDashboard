import { describe, expect, it } from 'vitest'
import { cumulative, tallyMonths } from './RunningTally'

const month = (revenue: number, direct_labor: number, extra: Partial<{ subcontractors: number; relay_ar: number; relay_ap: number }> = {}) =>
  ({ revenue, revenue_variable: null, direct_labor, payroll_taxes: 0, subcontractors: 0, relay_ar: 0, relay_ap: 0, timekeeping_labor: direct_labor, ...extra })
const job = (job_number: string, months: Record<string, ReturnType<typeof month>>, delivery_model: 'self_perform' | 'subcontracted' = 'self_perform') =>
  ({ company: 'C', job_number, job_name: null, role: 'site' as const, parent_job_number: null, delivery_model, months })

describe('running tally', () => {
  const data = { account: 'x', months: ['2025-12-01', '2026-01-01', '2026-02-01', '2026-03-01'], income_statement: {}, jobs: [
    job('1', { '2025-12-01': month(500, 300), '2026-01-01': month(1000, 600), '2026-02-01': month(1200, 700, { subcontractors: 50 }), '2026-03-01': month(1000, 400) }),
    job('2', { '2026-01-01': month(0, 0, { relay_ar: 900, relay_ap: 700, subcontractors: 650 }), '2026-02-01': month(0, 0, { relay_ar: 900, relay_ap: 0, subcontractors: 650 }) }, 'subcontracted'),
  ] }

  it('sums the closed months of the latest year, subcontracted sites at Relay AR and AP', () => {
    // March is half-loaded (job cost labor 400 of 900 timekept), so it is left out; December is the prior year.
    const months = tallyMonths({ ...data, jobs: [{ ...data.jobs[0], months: { ...data.jobs[0].months, '2026-03-01': { ...month(1000, 400), timekeeping_labor: 900 } } }, data.jobs[1]] })
    expect(months).toEqual([
      { month: '2026-01-01', revenue: 1900, labor: 600, sub: 700 },
      { month: '2026-02-01', revenue: 2100, labor: 700, sub: 700 },
    ])
  })

  it('carries running totals month to month', () => {
    expect(cumulative([{ month: 'a', revenue: 10, labor: 4, sub: 1 }, { month: 'b', revenue: 5, labor: 3, sub: 0 }]))
      .toEqual([{ month: 'a', revenue: 10, labor: 4, sub: 1 }, { month: 'b', revenue: 15, labor: 7, sub: 1 }])
  })
})
