import { describe, expect, it } from 'vitest'
import { SUITE_GROUPS } from '../leadership/routes'
import { SUITE_PAGES, resolveSuitePage, suiteGroupOf } from './pages'

describe('analytics suite pages', () => {
  const all = SUITE_GROUPS.flatMap((group) => SUITE_PAGES[group])

  it('carries the twelve Finance and Operations views, one route each', () => {
    expect(SUITE_PAGES.finance.map((p) => p.label)).toEqual(['Financial summary', 'Revenue analysis', 'Cost analysis', 'Margin & profitability', 'Billing & receivables', 'Budget vs actual', 'Forecast'])
    expect(SUITE_PAGES.operations.map((p) => p.label)).toEqual(['Labor cost', 'Hours & timekeeping', 'Sites portfolio', 'Account portfolio', 'Geographic operations'])
    expect(new Set(all.map((p) => p.key)).size).toBe(all.length)
  })

  it('falls back to the first page of a group', () => {
    expect(resolveSuitePage('finance', undefined).key).toBe('financial')
    expect(resolveSuitePage('finance', 'labor').key).toBe('financial')
    expect(resolveSuitePage('operations', 'jobs').key).toBe('jobs')
  })

  it('finds the group of a carried page and none for a retired one', () => {
    expect(suiteGroupOf('jobs')).toBe('operations')
    expect(suiteGroupOf('billing')).toBe('finance')
    expect(suiteGroupOf('admin')).toBeUndefined()
    expect(suiteGroupOf('overview')).toBeUndefined()
  })
})
