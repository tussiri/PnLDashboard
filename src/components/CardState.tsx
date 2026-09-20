import { AlertTriangle, Inbox, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import type { QueryState } from '../hooks/useApiQuery'
import { ApiError } from '../services/api'
import { errorMessage } from '../utils'
import { ChartCard } from './ChartCard'

export function Skeleton({ variant = 'chart', lines = 4, height }: { variant?: 'chart' | 'table' | 'kpi' | 'text'; lines?: number; height?: number | string }) {
  if (variant === 'chart') return <div className="skeleton skeleton--chart" style={{ height: height ?? '100%' }} aria-busy="true" aria-label="Loading"><div className="skeleton__bars">{Array.from({ length: 9 }, (_, i) => <i key={i} style={{ height: `${28 + ((i * 37) % 55)}%` }} />)}</div></div>
  if (variant === 'kpi') return <div className="skeleton skeleton--kpi" aria-busy="true" aria-label="Loading"><i style={{ width: '40%' }} /><i style={{ width: '65%', height: 22 }} /><i style={{ width: '50%' }} /></div>
  return <div className="skeleton skeleton--lines" style={{ height }} aria-busy="true" aria-label="Loading">{Array.from({ length: lines }, (_, i) => <i key={i} style={{ width: `${92 - ((i * 23) % 40)}%` }} />)}</div>
}

export function CardError({ error, onRetry, compact = false }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const detail = error instanceof ApiError ? (error.isNetwork ? `API unreachable · ${error.detail}` : `${error.status} · ${error.detail}`) : errorMessage(error)
  return (
    <div className={`card-state card-state--error ${compact ? 'card-state--compact' : ''}`} role="alert">
      <AlertTriangle size={compact ? 16 : 22} aria-hidden="true" />
      <strong>Couldn’t load this card</strong>
      <span>{detail}</span>
      {onRetry && <button type="button" className="secondary-button" onClick={onRetry}><RefreshCw size={13} aria-hidden="true" />Retry</button>}
    </div>
  )
}

export function CardEmpty({ title = 'Nothing to show', hint, compact = false, action }: { title?: string; hint?: string; compact?: boolean; action?: ReactNode }) {
  return (
    <div className={`card-state card-state--empty ${compact ? 'card-state--compact' : ''}`}>
      <Inbox size={compact ? 16 : 22} aria-hidden="true" />
      <strong>{title}</strong>
      {hint && <span>{hint}</span>}
      {action}
    </div>
  )
}

export function StaleChip({ fetching }: { fetching?: boolean }) {
  return <span className={`stale-chip ${fetching ? 'stale-chip--busy' : ''}`} title={fetching ? 'Refreshing' : 'Cached data older than a minute'}><RefreshCw size={10} aria-hidden="true" />{fetching ? 'Refreshing' : 'Cached'}</span>
}

interface QueryCardProps<T> {
  title: string
  subtitle?: string
  className?: string
  action?: ReactNode
  query: QueryState<T>
  /** Return true when the payload has nothing to draw; the empty state is shown instead of the chart. */
  isEmpty?: (data: T) => boolean
  emptyTitle?: string
  emptyHint?: string
  skeleton?: 'chart' | 'table' | 'kpi' | 'text'
  children: (data: T) => ReactNode
  /** Optional footnote below the body (units, method notes). */
  note?: ReactNode
}

/** ChartCard bound to a query: skeleton while loading, error + retry, empty explanation, else the chart. */
export function QueryCard<T>({ title, subtitle, className, action, query, isEmpty, emptyTitle, emptyHint, skeleton = 'chart', children, note }: QueryCardProps<T>) {
  const { data, error, loading, stale, fetching, refetch } = query
  let body: ReactNode
  if (loading) body = <Skeleton variant={skeleton} />
  else if (data === undefined) body = <CardError error={error} onRetry={refetch} />
  else if (isEmpty?.(data)) body = <CardEmpty title={emptyTitle} hint={emptyHint} />
  else body = children(data)
  const headerAction = <>{data !== undefined && error !== undefined && <span className="stale-chip stale-chip--error" title={errorMessage(error)}>Refresh failed</span>}{stale && data !== undefined && error === undefined && <StaleChip fetching={fetching} />}{action}</>
  return <ChartCard title={title} subtitle={subtitle} className={className} action={headerAction} note={note}>{body}</ChartCard>
}
