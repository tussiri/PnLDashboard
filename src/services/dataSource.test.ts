import { afterEach, describe, expect, it, vi } from 'vitest'
import { filtersToQuery } from '../context/DashboardContext'
import { defaultFilters } from '../types'
import { ApiError, api as liveApi, buildQuery, setAdminToken } from './api'
import { applyCollectible, collectibleAvailable } from './aging'
import type { ArAgingResponse, SystemStatus } from './apiTypes'
import { BANNERS, decideMode, detectMode } from './dataSource'

const status = (rows: number): SystemStatus => ({ database: 'ready', winteam: { enabled: false, configured: false, base_url_host: null, resources: [], poll_seconds: 300 }, marts: { latest_month: rows ? '2026-08-01' : null, rebuilt_at: null, job_month_rows: rows }, forecast: null })

describe('live/demo mode selection', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('chooses live when the marts contain job-month rows', () => {
    expect(decideMode(status(1200))).toMatchObject({ mode: 'live', reason: 'live', banner: null })
  })

  it('chooses demo with the empty-marts banner when the API is up but nothing is synced', () => {
    expect(decideMode(status(0))).toMatchObject({ mode: 'demo', reason: 'marts_empty', banner: BANNERS.marts_empty })
  })

  it('chooses demo with the unreachable banner when the status call fails', () => {
    const decision = decideMode(null, new ApiError(0, 'Failed to fetch', '/system/status'))
    expect(decision).toMatchObject({ mode: 'demo', reason: 'unreachable', banner: BANNERS.unreachable, error: 'Failed to fetch' })
  })

  it('detectMode calls GET /system/status and never throws for network failures', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(status(5)), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    expect((await detectMode()).mode).toBe('live')
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/v1\/system\/status$/)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await detectMode()).toMatchObject({ mode: 'demo', reason: 'unreachable' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"detail":"nope"}', { status: 500 })))
    expect((await detectMode()).error).toBe('nope')
  })

  it('sends the company filter as a query param and reaches the finance-reference routes', async () => {
    expect(filtersToQuery({ ...defaultFilters, company: 'Crane IFS East LLC' })).toMatchObject({ period: 'YTD', company: 'Crane IFS East LLC' })
    expect(filtersToQuery(defaultFilters).company).toBeUndefined()
    expect(buildQuery({ period: 'YTD', company: 'Crane IFS East LLC', account: undefined })).toBe('?period=YTD&company=Crane+IFS+East+LLC')
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(input), init }); return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }) }))
    await liveApi.jobs(filtersToQuery({ ...defaultFilters, company: 'Crane IFS East LLC' }))
    expect(calls[0].url).toMatch(/\/api\/v1\/jobs\?period=YTD&scope=key&company=Crane\+IFS\+East\+LLC$/)
    await liveApi.financeReference()
    expect(calls[1].url).toMatch(/\/api\/v1\/integrations\/finance-reference$/)
    // Without a token the call still goes out (an admin session may satisfy the API); the header is only added when a token is set.
    setAdminToken(null)
    await liveApi.loadFinanceReference()
    expect(calls[2].url).toMatch(/\/integrations\/finance-reference\/load$/)
    expect((calls[2].init?.headers as Record<string, string>)['X-Admin-Token']).toBeUndefined()
    setAdminToken('secret')
    await liveApi.loadFinanceReference()
    expect(calls[3].url).toMatch(/\/integrations\/finance-reference\/load$/)
    expect(calls[3].init?.method).toBe('POST')
    expect((calls[3].init?.headers as Record<string, string>)['X-Admin-Token']).toBe('secret')
    setAdminToken(null)
  })

  it('collectible-only view drops intercompany customers and re-sums buckets', () => {
    const row = (customer_number: string, is_collectible: boolean, current: number, d90_plus: number) => ({ customer_number, customer_name: customer_number, parent_account: customer_number, current, d30: 0, d60: 0, d90: 0, d90_plus, total: current + d90_plus, invoices: 2, is_collectible })
    const aging: ArAgingResponse = { source: { mode: 'live', as_of: '2026-08-10', latest_month: '2026-07-01', stale: false, primary_source: 'finance_reference', ar_as_of: '2026-08-10' }, as_of: '2026-08-10', total_open: 300, collectible_open: 200, dso_days: 40, by_customer: [row('A', true, 150, 50), row('IC', false, 100, 0)], buckets: [{ bucket: 'current', label: 'Current', amount: 250, invoices: 3 }, { bucket: 'd30', label: '1-30', amount: 0, invoices: 0 }, { bucket: 'd60', label: '31-60', amount: 0, invoices: 0 }, { bucket: 'd90', label: '61-90', amount: 0, invoices: 0 }, { bucket: 'd90_plus', label: '90+', amount: 50, invoices: 1 }] }
    expect(collectibleAvailable(aging)).toBe(true)
    expect(collectibleAvailable({ ...aging, collectible_open: undefined })).toBe(false)
    const on = applyCollectible(aging, true)
    expect(on.customers.map((c) => c.customer_number)).toEqual(['A'])
    expect(on.excluded.map((c) => c.customer_number)).toEqual(['IC'])
    expect(on.totalOpen).toBe(200)
    expect(on.buckets.find((b) => b.bucket === 'current')?.amount).toBe(150)
    expect(on.buckets.find((b) => b.bucket === 'd90_plus')?.amount).toBe(50)
    expect(on.invoiceCount).toBe(2)
    const off = applyCollectible(aging, false)
    expect(off.totalOpen).toBe(300)
    expect(off.customers).toHaveLength(2)
    expect(off.invoiceCount).toBe(4)
  })
})
