import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import type { SystemStatus } from './apiTypes'
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
})
