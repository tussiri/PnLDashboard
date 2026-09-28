import { ChevronDown, ChevronUp, Download } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { downloadCsv, toCsv } from '../services/csv'
import type { LaborStatus } from './metrics'

export const toneOf = (status: LaborStatus) => ({ on_target: 'ok', watch: 'warn', over: 'bad', no_billing: 'neutral' } as const)[status]
export const STATUS_LABEL: Record<LaborStatus, string> = { on_target: 'On target', watch: 'Watch', over: 'Over', no_billing: 'No billing' }
const BADGE_CLASS: Record<LaborStatus, string> = { on_target: 'bok', watch: 'bwarn', over: 'bbad', no_billing: 'bnone' }

export function Badge({ status, label }: { status: LaborStatus | 'none'; label?: string }) {
  if (status === 'none') return <span className="badge bnone">{label}</span>
  return <span className={`badge ${BADGE_CLASS[status]}`}>{label ?? STATUS_LABEL[status]}</span>
}

export function Kpi({ label, value, sub, tone, small }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string; small?: boolean }) {
  return <div className={`kpi${small ? ' sm' : ''}`}>
    <div className="kl">{label}</div>
    <div className={`kv ${tone ?? ''}`}>{value}</div>
    {sub != null && sub !== '' && <div className="ks">{sub}</div>}
  </div>
}

export function Pills<T extends string>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return <div className="pills" role="group" aria-label={label}>
    {options.map((o) => <button key={o.value} type="button" className="pill" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}
  </div>
}

export function Skeleton({ height = 120 }: { height?: number }) {
  return <div className="skel" style={{ height }} aria-hidden="true" />
}

export function LoadError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error ?? 'Request failed')
  return <div className="err" role="alert"><span>Could not load: {message}</span>{onRetry && <button type="button" className="btn sm" onClick={onRetry}>Retry</button>}</div>
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>

export interface Column<T> {
  key: string
  header: string
  /** Left-aligned text column. */
  left?: boolean
  value: (row: T) => number | string | null | undefined
  render?: (row: T) => ReactNode
  /** CSV cell; defaults to `value`. */
  csv?: (row: T) => unknown
  className?: string
  sortable?: boolean
}

interface SortState { key: string; dir: 1 | -1 }

/**
 * Sortable table. Headers are buttons (Enter and Space sort, aria-sort announces the order); nulls sort
 * last; a text column sorts ascending first and a number column descending first, as in the reference.
 */
export function SortTable<T>({ rows, columns, defaultSort, total, rowClass, onRowClick, rowLabel, csvName, caption, tools }: {
  rows: T[]
  columns: Column<T>[]
  defaultSort: SortState
  total?: ReactNode
  rowClass?: (row: T) => string
  onRowClick?: (row: T) => void
  rowLabel?: (row: T) => string
  csvName?: string
  caption: string
  tools?: ReactNode
}) {
  const [sort, setSort] = useState<SortState>(defaultSort)
  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort.key) ?? columns[0]
    return [...rows].sort((a, b) => {
      const x = col.value(a), y = col.value(b)
      if (x == null && y == null) return 0
      if (x == null) return 1
      if (y == null) return -1
      return typeof x === 'string' || typeof y === 'string' ? sort.dir * String(x).localeCompare(String(y)) : sort.dir * (x - y)
    })
  }, [rows, columns, sort])
  const toggle = (col: Column<T>) => setSort((s) => (s.key === col.key ? { key: col.key, dir: (s.dir * -1) as 1 | -1 } : { key: col.key, dir: col.left ? 1 : -1 }))
  const exportCsv = () => csvName && downloadCsv(csvName, toCsv(sorted, columns.map((c) => ({ key: c.key, header: c.header, value: c.csv ?? c.value }))))
  return <>
    {(csvName || tools) && <div className="table-tools">
      <div className="ctrl">{tools}</div>
      <div className="ctrl"><span className="count">{rows.length.toLocaleString('en-US')} rows</span>{csvName && <button type="button" className="btn sm" onClick={exportCsv}><Download size={13} aria-hidden="true" />CSV</button>}</div>
    </div>}
    <div className="tw">
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead><tr>{columns.map((c) => {
          const active = sort.key === c.key
          if (c.sortable === false) return <th key={c.key} className={`nosort${c.left ? ' l' : ''}`} scope="col">{c.header}</th>
          return <th key={c.key} className={c.left ? 'l' : ''} scope="col" aria-sort={active ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
            <button type="button" onClick={() => toggle(c)}>{c.header}{active && <span className="arr" aria-hidden="true">{sort.dir > 0 ? <ChevronUp size={10} /> : <ChevronDown size={10} />}</span>}</button>
          </th>
        })}</tr></thead>
        <tbody>
          {sorted.map((row, i) => <tr key={i} className={`${rowClass?.(row) ?? ''}${onRowClick ? ' click' : ''}`} onClick={onRowClick ? () => onRowClick(row) : undefined}>
            {columns.map((c, j) => <td key={c.key} className={`${c.left ? 'l ' : ''}${c.className ?? ''}`}>
              {j === 1 && onRowClick
                ? <button type="button" className="rowbtn" onClick={(e) => { e.stopPropagation(); onRowClick(row) }} aria-label={rowLabel?.(row)}>{c.render ? c.render(row) : c.value(row)}</button>
                : c.render ? c.render(row) : c.value(row)}
            </td>)}
          </tr>)}
          {total}
        </tbody>
      </table>
    </div>
  </>
}

/** A chart card with a legend row and a table view of the same data (the accessible alternative). */
export function ChartCard({ title, legend, height, chart, table, action }: { title: string; legend?: ReactNode; height: number; chart: ReactNode; table: ReactNode; action?: ReactNode }) {
  const [asTable, setAsTable] = useState(false)
  return <div className="card">
    <div className="ct"><span>{title}</span><span className="ctrl">{action}<button type="button" className="linkbtn" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>{asTable ? 'Chart' : 'Table'}</button></span></div>
    {asTable ? table : <>{legend && <div className="legend">{legend}</div>}<div className="cw" style={{ height }}>{chart}</div></>}
  </div>
}

export const Swatch = ({ color, label, line }: { color?: string; label: string; line?: boolean }) =>
  <span><i className={line ? 'line' : ''} style={line ? undefined : { background: color }} aria-hidden="true" />{label}</span>
