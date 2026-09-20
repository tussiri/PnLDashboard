import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { downloadCsv, toCsv } from '../services/csv'
import { CardEmpty } from './CardState'

export type SortDir = 'asc' | 'desc'
export type SortValue = string | number | boolean | null | undefined

export interface Column<T> {
  key: string
  header: string
  /** Value used for sorting and (unless `csv` is given) CSV export. Defaults to row[key]. */
  value?: (row: T) => SortValue
  render?: (row: T) => ReactNode
  csv?: (row: T) => unknown
  align?: 'left' | 'right' | 'center'
  width?: string
  sortable?: boolean
  /** Extra cell class, e.g. text-bad / text-good, decided per row. */
  className?: (row: T) => string | undefined
  /** Numeric columns get tabular figures. */
  numeric?: boolean
}

export interface SortState { key: string; dir: SortDir }

const compare = (a: SortValue, b: SortValue): number => {
  const aNull = a === null || a === undefined || a === '', bNull = b === null || b === undefined || b === ''
  if (aNull && bNull) return 0
  if (aNull) return 1 // nulls last regardless of direction
  if (bNull) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

export function columnValue<T>(column: Column<T>, row: T): SortValue {
  if (column.value) return column.value(row)
  const raw = (row as Record<string, unknown>)[column.key]
  return raw === null || raw === undefined ? null : typeof raw === 'number' || typeof raw === 'boolean' ? raw : String(raw)
}

/** Stable sort by one column; null/empty values always sort to the end. */
export function sortRows<T>(rows: T[], column: Column<T> | undefined, dir: SortDir): T[] {
  if (!column) return rows
  const decorated = rows.map((row, index) => ({ row, index, value: columnValue(column, row) }))
  decorated.sort((a, b) => {
    const aNull = a.value === null || a.value === undefined || a.value === '', bNull = b.value === null || b.value === undefined || b.value === ''
    if (aNull || bNull) return compare(a.value, b.value) || a.index - b.index
    const result = compare(a.value, b.value)
    return (dir === 'asc' ? result : -result) || a.index - b.index
  })
  return decorated.map((d) => d.row)
}

export interface DataGridProps<T> {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  defaultSort?: SortState
  onRowClick?: (row: T) => void
  onRowHover?: (row: T | null) => void
  highlightKey?: string | null
  /** Filename (without .csv) enables the export button. */
  csvName?: string
  emptyTitle?: string
  emptyHint?: string
  dense?: boolean
  /** Rows per page; omit for no pagination. */
  pageSize?: number
  /** Optional toolbar content rendered beside the row count (filters, search). */
  toolbar?: ReactNode
  /** Constrain height so the sticky header engages inside the card. */
  maxHeight?: number | string
  footer?: ReactNode
  caption?: string
}

/** Sortable, keyboard-accessible data grid with sticky header, optional row click, CSV export, and an empty state. */
export function DataGrid<T>({ rows, columns, rowKey, defaultSort, onRowClick, onRowHover, highlightKey, csvName, emptyTitle = 'No rows', emptyHint, dense = false, pageSize, toolbar, maxHeight, footer, caption }: DataGridProps<T>) {
  const [sort, setSort] = useState<SortState | null>(defaultSort ?? null)
  const [page, setPage] = useState(0)
  const sortColumn = sort ? columns.find((c) => c.key === sort.key) : undefined
  const sorted = useMemo(() => sortRows(rows, sortColumn, sort?.dir ?? 'asc'), [rows, sortColumn, sort?.dir])
  const pageCount = pageSize ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1
  const current = Math.min(page, pageCount - 1)
  const visible = pageSize ? sorted.slice(current * pageSize, (current + 1) * pageSize) : sorted

  const toggleSort = (column: Column<T>) => {
    if (column.sortable === false) return
    setSort((state) => (state?.key === column.key ? { key: column.key, dir: state.dir === 'asc' ? 'desc' : 'asc' } : { key: column.key, dir: column.numeric ? 'desc' : 'asc' }))
    setPage(0)
  }
  const exportCsv = () => downloadCsv(csvName ?? 'export', toCsv(sorted, columns.map((c) => ({ key: c.key, header: c.header, value: (row: T) => (c.csv ? c.csv(row) : columnValue(c, row)) }))))
  const onKey = (event: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (!onRowClick) return
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onRowClick(row) }
  }

  const hasToolbar = toolbar || csvName || pageSize
  return (
    <div className="data-grid">
      {hasToolbar && (
        <div className="data-grid__toolbar">
          <div className="data-grid__toolbar-left">{toolbar}</div>
          <div className="data-grid__toolbar-right">
            <span className="data-grid__count num">{sorted.length.toLocaleString()} {sorted.length === 1 ? 'row' : 'rows'}</span>
            {pageSize && pageCount > 1 && <span className="data-grid__pager"><button type="button" onClick={() => setPage(Math.max(0, current - 1))} disabled={current === 0} aria-label="Previous page"><ChevronLeft size={13} aria-hidden="true" /></button><span className="num">{current + 1} / {pageCount}</span><button type="button" onClick={() => setPage(Math.min(pageCount - 1, current + 1))} disabled={current >= pageCount - 1} aria-label="Next page"><ChevronRight size={13} aria-hidden="true" /></button></span>}
            {csvName && <button type="button" className="text-button" onClick={exportCsv} disabled={!sorted.length}><Download size={13} aria-hidden="true" />Export CSV</button>}
          </div>
        </div>
      )}
      <div className="data-grid__scroll" style={{ maxHeight }}>
        <table className={`data-grid__table ${dense ? 'data-grid__table--dense' : ''}`}>
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr>
              {columns.map((column) => {
                const active = sort?.key === column.key
                const sortable = column.sortable !== false
                const Icon = active ? (sort?.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
                return (
                  <th key={column.key} style={{ width: column.width }} className={`align-${column.align ?? (column.numeric ? 'right' : 'left')}`} aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : 'none'} scope="col">
                    {sortable ? <button type="button" className={`data-grid__sort ${active ? 'is-active' : ''}`} onClick={() => toggleSort(column)}><span>{column.header}</span><Icon size={11} aria-hidden="true" /></button> : <span className="data-grid__sort">{column.header}</span>}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const key = rowKey(row)
              return (
                <tr key={key} className={`${onRowClick ? 'is-clickable' : ''} ${highlightKey === key ? 'is-highlighted' : ''}`} tabIndex={onRowClick ? 0 : undefined} onClick={onRowClick ? () => onRowClick(row) : undefined} onKeyDown={(event) => onKey(event, row)} onMouseEnter={onRowHover ? () => onRowHover(row) : undefined} onMouseLeave={onRowHover ? () => onRowHover(null) : undefined} onFocus={onRowHover ? () => onRowHover(row) : undefined}>
                  {columns.map((column) => (
                    <td key={column.key} className={`align-${column.align ?? (column.numeric ? 'right' : 'left')} ${column.numeric ? 'num' : ''} ${column.className?.(row) ?? ''}`}>{column.render ? column.render(row) : String(columnValue(column, row) ?? '—')}</td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
        {!rows.length && <CardEmpty title={emptyTitle} hint={emptyHint} compact />}
      </div>
      {footer && <div className="data-grid__footer">{footer}</div>}
    </div>
  )
}
