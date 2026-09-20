import { describe, expect, it } from 'vitest'
import type { DimensionsResponse, SourceBlock, SystemStatus } from '../services/apiTypes'
import type { ModeDecision } from '../services/dataSource'
import { defaultFilters } from '../types'
import { applyScopeValue, countActiveFilters, countSecondaryFilters, dataStatus, navItems, scopeOptions, selectedScopeValue, sourceLine, subAccountOptions } from './AppShell'

describe('dashboard navigation', () => {
  it('uses one unique route per visible navigation item', () => {
    expect(new Set(navItems.map((item)=>item.key)).size).toBe(navItems.length)
  })

  it('counts the company filter as an active filter', () => {
    expect(countActiveFilters(defaultFilters)).toBe(0)
    expect(countActiveFilters({ ...defaultFilters, company: 'Crane IFS East LLC' })).toBe(1)
    expect(countActiveFilters({ ...defaultFilters, period: 'MTD', region: 'West', company: 'X' })).toBe(3)
  })
})

const dimensions = (extra: Partial<DimensionsResponse> = {}): DimensionsResponse => ({
  months: [], month_status: [], latest_month: null, latest_closed_month: null, default_month: null,
  accounts: ['FedEx', 'Amazon', 'Aldi', 'Riverbend Logistics', 'Cobalt Research'],
  regions: [], branches: [], service_types: [], verticals: [], customers: [],
  key_accounts: [
    { name: 'FedEx', label: 'FedEx (incl. FXE, FXG)', sites: 210, sub_accounts: [{ name: 'FedEx Express (FXE)', sites: 120 }, { name: 'FedEx Ground (FXG)', sites: 90 }] },
    { name: 'Amazon', label: 'Amazon', sites: 64, sub_accounts: [{ name: 'Amazon', sites: 64 }] },
  ],
  other_accounts: [{ name: 'Riverbend Logistics', sites: 4 }, { name: 'Cobalt Research', sites: 2 }],
  ...extra,
})

describe('scope-first filter counting', () => {
  it('does not count the default key scope, but counts all/other and an account drill-down', () => {
    expect(countActiveFilters(defaultFilters)).toBe(0)
    expect(countActiveFilters({ ...defaultFilters, scope: 'all' })).toBe(1)
    expect(countActiveFilters({ ...defaultFilters, scope: 'other' })).toBe(1)
    expect(countActiveFilters({ ...defaultFilters, account: 'FedEx' })).toBe(1)
    // Scope and account are mutually exclusive server-side, so they count once between them.
    expect(countActiveFilters({ ...defaultFilters, scope: 'all', account: 'FedEx' })).toBe(1)
    expect(countActiveFilters({ ...defaultFilters, account: 'FedEx', subAccount: 'FedEx Ground (FXG)' })).toBe(2)
    expect(countActiveFilters({ ...defaultFilters, subAccount: 'FedEx Ground (FXG)' })).toBe(0)
    expect(countActiveFilters({ ...defaultFilters, delivery: 'subcontracted' })).toBe(1)
  })

  it('badges "More filters" with the secondary row only', () => {
    expect(countSecondaryFilters(defaultFilters)).toBe(0)
    expect(countSecondaryFilters({ ...defaultFilters, scope: 'all', account: 'FedEx', period: 'MTD', month: '2026-06-01' })).toBe(0)
    expect(countSecondaryFilters({ ...defaultFilters, delivery: 'self_perform', region: 'West', company: 'Crane West' })).toBe(3)
  })
})

describe('grouped scope/account select', () => {
  it('leads with key accounts, then everything, then the long tail', () => {
    const groups = scopeOptions(dimensions())
    expect(groups.map((g) => g.label)).toEqual([null, 'Key accounts', 'Everything', 'Other accounts'])
    expect(groups[0].options).toEqual([{ value: 'scope:key', label: 'Key accounts · 2 accounts' }])
    expect(groups[1].options).toEqual([
      { value: 'account:FedEx', label: 'FedEx (incl. FXE, FXG) · 210 sites' },
      { value: 'account:Amazon', label: 'Amazon · 64 sites' },
    ])
    expect(groups[2].options).toEqual([{ value: 'scope:all', label: 'All accounts' }, { value: 'scope:other', label: 'Other accounts · 2' }])
    expect(groups[3].options).toEqual([{ value: 'account:Riverbend Logistics', label: 'Riverbend Logistics' }, { value: 'account:Cobalt Research', label: 'Cobalt Research' }])
  })

  it('falls back to /dimensions.accounts on API builds without key_accounts', () => {
    const groups = scopeOptions(dimensions({ key_accounts: undefined, other_accounts: undefined }))
    expect(groups.map((g) => g.label)).toEqual([null, 'Everything', 'Accounts'])
    expect(groups[0].options[0]).toEqual({ value: 'scope:key', label: 'Key accounts' })
    expect(groups[2].options).toHaveLength(5)
  })

  it('renders three scope options and no groups before /dimensions arrives', () => {
    expect(scopeOptions(undefined).flatMap((g) => g.options).map((o) => o.value)).toEqual(['scope:key', 'scope:all', 'scope:other'])
  })

  it('selects the account over the scope, mirroring the API precedence', () => {
    expect(selectedScopeValue(defaultFilters)).toBe('scope:key')
    expect(selectedScopeValue({ ...defaultFilters, scope: 'all' })).toBe('scope:all')
    expect(selectedScopeValue({ ...defaultFilters, scope: 'all', account: 'FedEx' })).toBe('account:FedEx')
  })

  it('clears the account when a scope is chosen and the sub-account when the account changes', () => {
    const drilled = applyScopeValue(defaultFilters, 'account:FedEx')
    expect(drilled).toMatchObject({ account: 'FedEx', subAccount: '' })
    const withSub = { ...drilled, subAccount: 'FedEx Ground (FXG)' }
    expect(applyScopeValue(withSub, 'account:FedEx').subAccount).toBe('FedEx Ground (FXG)')
    expect(applyScopeValue(withSub, 'account:Amazon')).toMatchObject({ account: 'Amazon', subAccount: '' })
    expect(applyScopeValue(withSub, 'scope:all')).toMatchObject({ scope: 'all', account: '', subAccount: '' })
  })

  it('offers a sub-account select only for a key account with two or more sub-accounts', () => {
    expect(subAccountOptions(dimensions(), 'FedEx')).toHaveLength(2)
    expect(subAccountOptions(dimensions(), 'Amazon')).toEqual([])
    expect(subAccountOptions(dimensions(), 'Riverbend Logistics')).toEqual([])
    expect(subAccountOptions(dimensions(), '')).toEqual([])
  })
})

describe('data-status pill', () => {
  const live: ModeDecision = { mode: 'live', reason: 'live', banner: null, status: null, error: null }
  const now = Date.parse('2026-09-01T12:00:00Z')
  const status = (sources?: SystemStatus['sources']): SystemStatus => ({ database: { ok: true }, winteam: { enabled: true, configured: true, base_url_host: 'api.winteam', resources: [], poll_seconds: 300 }, marts: { latest_month: '2026-07-01', rebuilt_at: '2026-09-01T11:50:00Z', job_month_rows: 900 }, forecast: null, sources })
  const src = (extra: Partial<SourceBlock>): SourceBlock => ({ mode: 'live', as_of: '2026-09-01T11:50:00Z', synced_at: '2026-09-01T11:50:00Z', latest_month: '2026-07-01', stale: false, ...extra })

  it('names the finance reference source with the AR snapshot date', () => {
    const pill = dataStatus('live', live, status(), src({ primary_source: 'finance_reference', ar_as_of: '2026-08-10' }), now)
    expect(pill.label).toBe('Live · WinTeam exports (Finance reference) · AR as of Aug 10, 2026')
    expect(pill.tone).toBe('live')
    expect(pill.lines.some((l) => l.startsWith('Primary source: WinTeam exports (Finance reference)'))).toBe(true)
    expect(sourceLine(src({ primary_source: 'finance_reference', ar_as_of: '2026-08-10' }), null)).toBe('Live · WinTeam exports (Finance reference) · AR as of Aug 10, 2026')
  })

  it('does not call a loaded reference snapshot stale because of its age, but honours the server flag', () => {
    const old = src({ primary_source: 'finance_reference', ar_as_of: '2026-08-10', synced_at: '2026-08-12T00:00:00Z', as_of: '2026-08-12T00:00:00Z' })
    expect(dataStatus('live', live, status(), old, now).tone).toBe('live')
    expect(dataStatus('live', live, status(), { ...old, stale: true }, now).label).toBe('Stale · WinTeam exports (Finance reference) · AR as of Aug 10, 2026')
  })

  it('names the WinTeam API source and keeps the sync age; falls back to /system/status sources before any payload', () => {
    expect(dataStatus('live', live, status(), src({ primary_source: 'winteam_api' }), now).label).toBe('Live · WinTeam API · synced 10m ago')
    expect(dataStatus('live', live, status(), src({}), now).label).toBe('Live · synced 10m ago')
    const fromStatus = status([{ name: 'winteam_api', configured: true, enabled: false, last_status: null, last_completed_at: null, records: 0 }, { name: 'finance_reference', configured: true, enabled: true, last_status: 'succeeded', last_completed_at: '2026-09-01T11:00:00Z', records: 5000 }])
    expect(dataStatus('live', live, fromStatus, null, now).label).toBe('Live · WinTeam exports (Finance reference)')
    expect(sourceLine(null, fromStatus)).toBe('Live · WinTeam exports (Finance reference)')
  })
})
