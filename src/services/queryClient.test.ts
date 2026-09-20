import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, queryKey } from './queryClient'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('query cache', () => {
  afterEach(() => vi.restoreAllMocks())

  it('de-duplicates concurrent fetches for the same key', async () => {
    const client = new QueryClient()
    const fetcher = vi.fn(async () => ({ ok: true }))
    const [a, b] = await Promise.all([client.fetch('jobs', fetcher), client.fetch('jobs', fetcher)])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(client.get('jobs')?.data).toEqual({ ok: true })
  })

  it('aborts the underlying request only when every subscriber detaches', async () => {
    const client = new QueryClient()
    let seen: AbortSignal | undefined
    const fetcher = (signal: AbortSignal) => new Promise<string>((resolve, reject) => {
      seen = signal
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      setTimeout(() => resolve('done'), 30)
    })
    const first = new AbortController(), second = new AbortController()
    const p1 = client.fetch('slow', fetcher, first.signal)
    const p2 = client.fetch('slow', fetcher, second.signal)
    const outcome1 = expect(p1).rejects.toMatchObject({ name: 'AbortError' })
    const outcome2 = expect(p2).rejects.toMatchObject({ name: 'AbortError' })
    first.abort()
    await flush()
    expect(seen?.aborted).toBe(false)
    second.abort()
    await flush()
    expect(seen?.aborted).toBe(true)
    await outcome1
    await outcome2
    expect(client.get('slow')).toBeUndefined()
  })

  it('serves cached data, reports staleness, and invalidates by exact key or prefix', async () => {
    const client = new QueryClient({ staleMs: 10 })
    await client.fetch('live/jobs?period=YTD', async () => 1)
    await client.fetch('live/jobs?period=MTD', async () => 2)
    await client.fetch('demo/jobs', async () => 3)
    expect(client.isStale('live/jobs?period=YTD', Date.now() + 50)).toBe(true)
    client.invalidate('live/jobs?period=YTD', true)
    expect(client.get('live/jobs?period=YTD')).toBeUndefined()
    expect(client.get('live/jobs?period=MTD')?.data).toBe(2)
    client.invalidate('live/')
    expect(client.get('live/jobs?period=MTD')).toBeUndefined()
    expect(client.get('demo/jobs')?.data).toBe(3)
  })

  it('keeps prior data alongside a refresh error and notifies subscribers', async () => {
    const client = new QueryClient()
    const listener = vi.fn()
    client.subscribe('k', listener)
    await client.fetch('k', async () => 'first')
    await expect(client.fetch('k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(client.get('k')?.data).toBe('first')
    expect(client.get('k')?.error).toBeInstanceOf(Error)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('builds stable keys with sorted params and dropped blanks', () => {
    expect(queryKey('jobs', { period: 'YTD', account: '', region: undefined, branch: 'Boston' })).toBe('jobs?branch=Boston&period=YTD')
    expect(queryKey('jobs', {})).toBe('jobs')
  })
})
