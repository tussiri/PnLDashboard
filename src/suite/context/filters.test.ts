import { describe, expect, it } from 'vitest'
import { FILTERS_STORAGE_KEY, FILTERS_STORAGE_KEY_V2, filtersToQuery, migrateStoredFilters, normalizeFilters } from './DashboardContext'
import { defaultFilters } from '../types'

describe('scope-first filter defaults', () => {
  it('opens on the key accounts, year to date, with nothing else set', () => {
    expect(defaultFilters).toEqual({ period: 'YTD', month: null, scope: 'key', account: '', subAccount: '', delivery: 'all', region: '', branch: '', serviceType: '', vertical: '', company: '' })
  })
})

describe('filtersToQuery', () => {
  it('sends scope only when no account is selected (the API ignores it otherwise)', () => {
    expect(filtersToQuery(defaultFilters)).toMatchObject({ period: 'YTD', scope: 'key' })
    expect(filtersToQuery({ ...defaultFilters, scope: 'other' }).scope).toBe('other')
    const drilled = filtersToQuery({ ...defaultFilters, scope: 'all', account: 'FedEx' })
    expect(drilled.scope).toBeUndefined()
    expect(drilled.account).toBe('FedEx')
  })

  it('sends sub_account only alongside an account (the API answers 422 without one)', () => {
    expect(filtersToQuery({ ...defaultFilters, subAccount: 'FedEx Ground (FXG)' }).sub_account).toBeUndefined()
    expect(filtersToQuery({ ...defaultFilters, account: 'FedEx', subAccount: 'FedEx Ground (FXG)' }).sub_account).toBe('FedEx Ground (FXG)')
    expect(filtersToQuery({ ...defaultFilters, account: 'FedEx' }).sub_account).toBeUndefined()
  })

  it("omits the default delivery ('all') and sends the two real models", () => {
    expect(filtersToQuery(defaultFilters).delivery).toBeUndefined()
    expect(filtersToQuery({ ...defaultFilters, delivery: 'subcontracted' }).delivery).toBe('subcontracted')
    expect(filtersToQuery({ ...defaultFilters, delivery: 'self_perform' }).delivery).toBe('self_perform')
  })

  it('drops every empty dimension and keeps the anchor month', () => {
    expect(filtersToQuery({ ...defaultFilters, month: '2026-06-01', region: 'West' })).toEqual({
      period: 'YTD', month: '2026-06-01', scope: 'key', account: undefined, sub_account: undefined, delivery: undefined,
      region: 'West', branch: undefined, service_type: undefined, vertical: undefined, company: undefined,
    })
  })
})

describe('filter storage migration', () => {
  it('uses distinct v3 / v2 keys', () => {
    expect(FILTERS_STORAGE_KEY).toBe('northstar-facilities-filters-v3')
    expect(FILTERS_STORAGE_KEY_V2).toBe('northstar-facilities-filters-v2')
  })

  it('migrates a v2 value: its account becomes the drill-down and scope starts at the default', () => {
    const v2 = JSON.stringify({ period: 'QTD', month: '2026-05-01', account: 'Amazon', region: 'West', branch: '', serviceType: '', vertical: '', company: 'Crane West' })
    expect(migrateStoredFilters(null, v2)).toEqual({ ...defaultFilters, period: 'QTD', month: '2026-05-01', scope: 'key', account: 'Amazon', region: 'West', company: 'Crane West' })
  })

  it('defaults a v2 value with no account to the key-account scope, not to all accounts', () => {
    const v2 = JSON.stringify({ period: 'YTD', month: null, account: '', region: '', branch: '', serviceType: '', vertical: '', company: '' })
    expect(migrateStoredFilters(null, v2)).toEqual(defaultFilters)
  })

  it('prefers a stored v3 value and ignores the stale v2 one', () => {
    const v3 = JSON.stringify({ ...defaultFilters, scope: 'all', delivery: 'subcontracted' })
    const v2 = JSON.stringify({ ...defaultFilters, account: 'Amazon' })
    expect(migrateStoredFilters(v3, v2)).toMatchObject({ scope: 'all', delivery: 'subcontracted', account: '' })
  })

  it('falls back to the defaults on missing or unparseable storage', () => {
    expect(migrateStoredFilters(null, null)).toEqual(defaultFilters)
    expect(migrateStoredFilters('not json', null)).toEqual(defaultFilters)
    expect(migrateStoredFilters('[]', null)).toEqual(defaultFilters)
  })

  it('rejects out-of-contract values and a sub-account with no account', () => {
    expect(normalizeFilters({ period: 'WEEKLY', scope: 'everything', delivery: 'maybe' })).toEqual(defaultFilters)
    expect(normalizeFilters({ subAccount: 'FedEx Ground (FXG)' }).subAccount).toBe('')
    expect(normalizeFilters({ account: 'FedEx', subAccount: 'FedEx Ground (FXG)' }).subAccount).toBe('FedEx Ground (FXG)')
  })
})
