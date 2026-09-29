import { describe, expect, it } from 'vitest'
import type { LeadershipAccount, LeadershipRow } from '../services/apiTypes'
import { prepareRows } from './data'

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
