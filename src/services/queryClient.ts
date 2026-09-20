/**
 * Small in-memory query cache with request de-duplication and reference-counted
 * abort. Framework-free so it can be unit tested; `useApiQuery` is a thin hook over it.
 */
export type Fetcher<T> = (signal: AbortSignal) => Promise<T>

interface CacheEntry<T = unknown> {
  data?: T
  error?: unknown
  updatedAt: number
}

interface InFlight<T = unknown> {
  promise: Promise<T>
  controller: AbortController
  subscribers: number
}

export interface QueryClientOptions {
  /** Cached data older than this is served but marked stale and refetched. */
  staleMs?: number
}

export class QueryClient {
  private cache = new Map<string, CacheEntry>()
  private inflight = new Map<string, InFlight>()
  private listeners = new Map<string, Set<() => void>>()
  readonly staleMs: number

  constructor(options: QueryClientOptions = {}) {
    this.staleMs = options.staleMs ?? 60_000
  }

  get<T>(key: string): CacheEntry<T> | undefined {
    return this.cache.get(key) as CacheEntry<T> | undefined
  }

  isStale(key: string, now = Date.now()): boolean {
    const entry = this.cache.get(key)
    return !entry || now - entry.updatedAt > this.staleMs
  }

  isFetching(key: string): boolean {
    return this.inflight.has(key)
  }

  subscribe(key: string, listener: () => void): () => void {
    let set = this.listeners.get(key)
    if (!set) { set = new Set(); this.listeners.set(key, set) }
    set.add(listener)
    return () => { set?.delete(listener); if (set && set.size === 0) this.listeners.delete(key) }
  }

  private notify(key: string) {
    this.listeners.get(key)?.forEach((listener) => listener())
  }

  /**
   * Fetch (or join an in-flight fetch for) `key`. The caller's `signal` detaches
   * this subscriber; the underlying request is only aborted once every subscriber
   * has detached.
   */
  fetch<T>(key: string, fetcher: Fetcher<T>, signal?: AbortSignal): Promise<T> {
    let flight = this.inflight.get(key) as InFlight<T> | undefined
    if (!flight) {
      const controller = new AbortController()
      const created: InFlight<T> = { controller, subscribers: 0, promise: Promise.resolve() as unknown as Promise<T> }
      created.promise = fetcher(controller.signal).then(
        (data) => { this.cache.set(key, { data, updatedAt: Date.now() }); this.inflight.delete(key); this.notify(key); return data },
        (error) => {
          this.inflight.delete(key)
          if (!controller.signal.aborted) { const prior = this.cache.get(key); this.cache.set(key, { data: prior?.data, error, updatedAt: prior?.updatedAt ?? 0 }); this.notify(key) }
          throw error
        },
      )
      this.inflight.set(key, created)
      flight = created
    }
    flight.subscribers += 1
    const detach = () => {
      if (!flight) return
      flight.subscribers -= 1
      if (flight.subscribers <= 0 && this.inflight.get(key) === flight) { flight.controller.abort(); this.inflight.delete(key) }
    }
    if (signal) {
      if (signal.aborted) detach()
      else signal.addEventListener('abort', detach, { once: true })
    }
    return flight.promise.finally(() => signal?.removeEventListener('abort', detach))
  }

  /** Remove cached entries matching `key` (exact) or starting with it (prefix; all when omitted) and notify subscribers. */
  invalidate(key?: string, exact = false) {
    for (const cached of [...this.cache.keys()]) {
      const match = !key || (exact ? cached === key : cached.startsWith(key))
      if (match) { this.cache.delete(cached); this.notify(cached) }
    }
    if (key && exact && !this.cache.has(key)) this.notify(key)
  }

  setData<T>(key: string, data: T) {
    this.cache.set(key, { data, updatedAt: Date.now() })
    this.notify(key)
  }

  clear() {
    this.cache.clear()
    for (const flight of this.inflight.values()) flight.controller.abort()
    this.inflight.clear()
  }
}

export const queryClient = new QueryClient()

/** Stable cache key from a route name and a params object (undefined/null/'' dropped, keys sorted). */
export function queryKey(route: string, params?: Record<string, unknown>): string {
  if (!params) return route
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').sort(([a], [b]) => a.localeCompare(b))
  return entries.length ? `${route}?${entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}` : route
}
