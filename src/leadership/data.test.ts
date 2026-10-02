import { describe, expect, it } from 'vitest'
import type { LeadershipAccount, LeadershipRow } from '../services/apiTypes'
import { closedMonths, monthRevenue, prepareRows, weekBudgetOf, weekdaysIn } from './data'

const row = (job: string, extra: Partial<LeadershipRow> = {}): LeadershipRow => ({
  week_start: '2026-09-14', week_end: '2026-09-20', company: 'Crane West', job_number: job, site_name: `Site ${job}`, parent_account: 'FedEx',
  account_slug: 'fedex', segment: 'FedEx', role: 'site', needs_review: false, hours: 10, ot_hours: 1, labor: 200, labor_basis: 'pay_report',
  ot_dollars: 30, budget_hours: 0, budget_dollars: 0, employees: 1, days_with_labor: 5, revenue_month: '2026-08-01', revenue_month_amount: 4330,
  revenue_allocated: 0, revenue_month_basis: 'job_cost', invoice_week: null, prior_revenue: 0, prior_labor: 0, prior_labor_basis: null, prior_sub: 0,
  prior_sub_basis: null, delivery_model: 'self_perform', sub_week: 0, sub_week_basis: null, consumables_cost: null, consumables_basis: null,
  latitude: null, longitude: null, city: null, state_province: null, revenue_run_rate: 4000, ...extra,
})
const fedex = { slug: 'fedex', group_by: 'pallet', split_subcontracted: true } as LeadershipAccount
const bySlug = (slug: string | undefined) => (slug === 'fedex' ? fedex : undefined)

describe('prepareRows (the weekly reports\' site shape)', () => {
  it('rolls a pallet job into its site, groups pallet sites and drops subcontracted sites', () => {
    const out = prepareRows([
      row('39'), row('391', { role: 'pallet', parent_job_number: '39', labor: 500, hours: 20, ot_hours: 4, revenue_month_amount: 0, revenue_run_rate: 0 }),
      row('34'), row('41', { delivery_model: 'subcontracted', hours: 0, labor: 0, sub_week: 900 }),
    ], bySlug)
    const site = out.find((r) => r.job_number === '39')!
    expect(out.map((r) => r.job_number).sort()).toEqual(['34', '39'])
    expect(site.kids).toEqual(['39', '391'])
    expect([site.labor, site.hours, site.ot_hours, site.pallet_labor, site.pallet_hours, site.pallet_ot_hours]).toEqual([700, 30, 5, 500, 20, 4])
    expect(site.segment).toBe('Pallet sites')
    expect(out.find((r) => r.job_number === '34')!.segment).toBe('Janitorial only')
  })

  it('keeps an orphan pallet job as its own site and leaves other accounts alone', () => {
    const out = prepareRows([row('481', { role: 'pallet', parent_job_number: '48' }), row('7', { account_slug: 'amazon', segment: 'Crane IFS', delivery_model: 'subcontracted' })], bySlug)
    expect(out.map((r) => [r.job_number, r.role, r.segment])).toEqual([['7', 'site', 'Crane IFS'], ['481', 'site', 'Janitorial only']])
  })
})

describe('closedMonths', () => {
  const month = (revenue: number, direct_labor: number, timekeeping_labor: number, relay_ar = 0) =>
    ({ revenue, revenue_variable: null, direct_labor, payroll_taxes: 0, subcontractors: 0, relay_ar, relay_ap: 0, timekeeping_labor })
  const job = (months: Record<string, ReturnType<typeof month>>, delivery_model: 'self_perform' | 'subcontracted' = 'self_perform') =>
    ({ company: 'C', job_number: '1', job_name: null, role: 'site' as const, parent_job_number: null, delivery_model, months })

  it('keeps months whose job cost revenue and labor are posted, and drops half-loaded ones', () => {
    const data = { account: 'x', months: ['2026-06-01', '2026-07-01', '2026-08-01'], income_statement: {}, jobs: [
      job({ '2026-06-01': month(1000, 600, 610), '2026-07-01': month(1000, 400, 620), '2026-08-01': month(0, 300, 600, 1000) }),
      job({ '2026-06-01': month(0, 0, 0, 9000), '2026-07-01': month(0, 0, 0, 9000), '2026-08-01': month(0, 0, 0, 9000) }, 'subcontracted'),
    ] }
    // July: revenue in, labor 400 of 620 timekept (65%); August: carried by Relay billing. Subcontracted jobs are ignored.
    expect(closedMonths(data)).toEqual(['2026-06-01'])
  })
})

describe('monthRevenue', () => {
  const m = { revenue: 4030.48, relay_ar: 189143.5 } as never
  it('takes Relay AR first for a subcontracted job, whose contract revenue has no job in job cost', () => {
    expect(monthRevenue(m, true)).toBe(189143.5)
    expect(monthRevenue({ revenue: 4030.48, relay_ar: 0 } as never, true)).toBe(4030.48)
  })
  it('takes job cost first for other jobs', () => {
    expect(monthRevenue(m)).toBe(4030.48)
    expect(monthRevenue({ revenue: 0, relay_ar: 900 } as never)).toBe(900)
    expect(monthRevenue(undefined, true)).toBe(0)
  })
})

describe('weekBudgetOf', () => {
  const month = (m: string, total: number) => ({ month: `${m}-01`, in_progress: false, details: {}, supplies: null, actual: null, variance: null,
    budget: { site: total, overhead: 0, total, revenue: null, labor_pct: null } })
  const weeks = [{ week_end: '2026-09-13', site: 155691.58, overhead: 9578.54, holiday: 37069.42, details: { school_days: 4, stat_holidays: 1 } }]
  it('uses the weekly calendar, holiday pay only when paid', () => {
    expect(weekBudgetOf('2026-09-07', weeks, [], false)).toMatchObject({ labor: 165270.12, source: 'calendar' })
    expect(weekBudgetOf('2026-09-07', weeks, [], true)!.labor).toBeCloseTo(202339.54, 2)
  })
  it('falls back to the monthly plan spread over weekdays (Crowley with a monthly plan only)', () => {
    // September 2026 has 22 weekdays; the week of Sep 21 is five of them.
    expect(weekdaysIn('2026-09')).toBe(22)
    expect(weekBudgetOf('2026-09-21', undefined, [month('2026-09', 440000)], false)).toMatchObject({ labor: 100000, source: 'monthly' })
    // A week across two months takes each day from its own month.
    const b = weekBudgetOf('2026-09-28', undefined, [month('2026-09', 440000), month('2026-10', 460000)], false)!
    expect(b.labor).toBeCloseTo(3 * 20000 + 2 * (460000 / 22), 2) // Sep 28-30 at 440K/22, Oct 1-2 at 460K/22
    expect(weekBudgetOf('2026-09-21', undefined, [], false)).toBeNull()
  })
})
