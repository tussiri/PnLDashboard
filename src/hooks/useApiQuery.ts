import { useCallback, useEffect, useRef, useState } from 'react'
import { queryClient, type Fetcher } from '../services/queryClient'

export interface QueryState<T> {
  data: T | undefined
  error: unknown
  /** No data yet and no terminal error: render a skeleton. */
  loading: boolean
  /** Visible data came from cache and is either older than staleMs or being refreshed. */
  stale: boolean
  fetching: boolean
  refetch: () => void
  /** Fetch again in the background, keeping the visible data until the new data arrives. */
  reload: () => void
}

/**
 * Fetch `key` through the shared query cache. `key === null` disables the query.
 * Concurrent callers with the same key share one request; unmounting detaches
 * the caller and aborts the request once nobody else is waiting for it.
 */
export function useApiQuery<T>(key: string | null, fetcher: Fetcher<T>, deps: unknown[] = []): QueryState<T> {
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const [, force] = useState(0)
  const rerender = useCallback(() => force((n) => n + 1), [])

  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    const ensure = () => {
      if (controller.signal.aborted || queryClient.isFetching(key)) return
      const cached = queryClient.get<T>(key)
      const needsFetch = !cached || cached.error !== undefined || queryClient.isStale(key)
      if (needsFetch) queryClient.fetch(key, (signal) => fetcherRef.current(signal), controller.signal).then(rerender, rerender)
    }
    const unsubscribe = queryClient.subscribe(key, () => {
      // An invalidation removes the entry; refetch so subscribed cards recover.
      if (!queryClient.get(key)) ensure()
      rerender()
    })
    ensure()
    rerender()
    return () => { controller.abort(); unsubscribe() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps])

  const refetch = useCallback(() => { if (key) queryClient.invalidate(key, true) }, [key])
  const reload = useCallback(() => { if (key) queryClient.fetch(key, (signal) => fetcherRef.current(signal)).catch(() => undefined) }, [key])
  if (!key) return { data: undefined, error: undefined, loading: false, stale: false, fetching: false, refetch, reload }
  const entry = queryClient.get<T>(key)
  const fetching = queryClient.isFetching(key)
  const hasData = entry?.data !== undefined
  return {
    data: entry?.data,
    error: entry?.error,
    loading: !hasData && entry?.error === undefined,
    stale: hasData && (fetching || queryClient.isStale(key)),
    fetching,
    refetch,
    reload,
  }
}
