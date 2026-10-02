import { describe, expect, it } from 'vitest'
import { formatRoute, monthLabel, parseRoute, weekEndOf, weekLabel, weekStartOf, weekTick, type Route } from './routes'

describe('leadership routes', () => {
  it('round-trips every view with its selections', () => {
    const routes: Route[] = [
      { view: 'company', account: 'plano-isd', week: '2026-09-20', target: 64.5 },
      { view: 'account', account: 'plano-isd', tab: 'sites', week: '2026-09-20', site: { company: 'Crane Southwest', job: '801' } },
      { view: 'account', account: 'fedex', tab: 'overview' },
      { view: 'account', account: 'fedex', tab: 'sites', selfOnly: true, basis: 'last_month' },
      { view: 'analytics', week: '2026-09-20', account: 'other', status: 'over', q: 'elementary', segment: 'High School' },
      { view: 'admin', adminTab: 'imports' },
      { view: 'admin', adminTab: 'allocations' },
      { view: 'company', week: '2026-09-20' },
      { view: 'account', account: 'fedex', tab: 'sites', period: 'month', month: '2026-08' },
      { view: 'analytics', analyticsTab: 'units', week: '2026-09-20' },
    ]
    for (const route of routes) expect(parseRoute(formatRoute(route))).toEqual(route)
  })

  it('writes readable URLs', () => {
    expect(formatRoute({ view: 'company', account: 'plano-isd', week: '2026-09-20', target: 64.5 })).toBe('#/company?account=plano-isd&week=2026-09-20&target=64.5')
    expect(formatRoute({ view: 'account', account: 'plano-isd', tab: 'over-target' })).toBe('#/account/plano-isd/over-target')
    expect(formatRoute({ view: 'admin', adminTab: 'accounts', week: '2026-09-20' })).toBe('#/admin')
  })

  it('falls back safely on unknown or malformed input', () => {
    expect(parseRoute('')).toEqual({ view: 'company' })
    expect(parseRoute('#/overview')).toEqual({ view: 'company' })
    expect(parseRoute('#/account/amazon/nonsense?week=Sept&target=abc')).toEqual({ view: 'account', account: 'amazon', tab: 'overview' })
    expect(parseRoute('#/admin/unknown')).toEqual({ view: 'admin', adminTab: 'accounts' })
    expect(parseRoute('#/company?site=noseparator').site).toBeUndefined()
    expect(parseRoute('#/company?site=Crane%20IFS~12~A').site).toEqual({ company: 'Crane IFS~12', job: 'A' })
  })

  it('labels Monday weeks by their ending Sunday', () => {
    expect(weekEndOf('2026-09-14')).toBe('2026-09-20')
    expect(weekStartOf('2026-09-20')).toBe('2026-09-14')
    expect(weekStartOf('2026-09-14')).toBe('2026-09-14')
    expect(weekLabel('2026-09-14')).toBe('Week ending Sep 20, 2026')
    expect(weekTick('2026-08-31')).toBe('Sep 6')
    expect(monthLabel('2026-08-01')).toBe('Aug 2026')
  })
})

describe('navigation', () => {
  it('lands on Company, sends old Home links to the account, and names Portfolio', () => {
    expect(parseRoute('#/').view).toBe('company')
    expect(parseRoute('#/?account=fedex&week=2026-09-27')).toEqual({ view: 'account', account: 'fedex', tab: 'overview', week: '2026-09-27' })
    expect(parseRoute('#/home?account=amazon&period=month&month=2026-08')).toMatchObject({ view: 'account', account: 'amazon', period: 'month', month: '2026-08' })
    expect(parseRoute('#/analytics/units').analyticsTab).toBe('units')
    expect(formatRoute({ view: 'analytics', analyticsTab: 'units' })).toBe('#/portfolio/units')
    expect(parseRoute('#/portfolio').view).toBe('analytics')
  })
})
