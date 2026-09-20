/**
 * Chart cards for the Executive Overview: a titled card (legend, headline, chart, note) with an "Expand"
 * control that opens a full-width dialog - the same chart at 480 px, the weekly data table beneath it and
 * a CSV export. The dialog is role="dialog" + aria-modal, closes on Escape / backdrop, traps Tab focus and
 * returns focus to the Expand button. `compact` is the site-grid variant (smaller title, 120 px chart).
 */
import { useEffect, useId, useReducer, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { downloadCsv } from '../../services/csv'
import { csvFileName, dialogKeyAction, expandReducer, formatCell, isNumericKind, trapFocus, weeklyCsv, type WeeklyTable } from './charts'

export interface LegendItem { label: string; color: string; kind?: 'line' | 'dashed' | 'bar' | 'hatched' }

export interface ChartCardProps {
  title: string
  titleColor?: string
  subtitle?: ReactNode
  /** Headline text above the chart (site cards: latest value · WoW · ~est). */
  headline?: ReactNode
  legend?: LegendItem[]
  /** Renders the chart at a height: the card's own height, or 480 px inside the dialog. */
  chart: (height: number, expanded: boolean) => ReactNode
  /** Chart height on the card (min 260 for full cards, 120 for compact). */
  height?: number
  /** Weekly data table for the dialog (also exported as CSV). */
  table?: WeeklyTable
  csvName?: string
  note?: ReactNode
  compact?: boolean
  className?: string
  children?: ReactNode
}

const FULL_HEIGHT = 260
const COMPACT_HEIGHT = 120
const DIALOG_HEIGHT = 480

export function Legend({ items }: { items: LegendItem[] }) {
  return <div className="lgd" aria-label="Legend">{items.map((it) => <span key={it.label}><span className={`lk lk-${it.kind ?? 'line'}`} style={{ color: it.color }} aria-hidden="true" />{it.label}</span>)}</div>
}

export function ChartCard(props: ChartCardProps) {
  const { title, titleColor, subtitle, headline, legend, chart, table, csvName, note, compact, className, children } = props
  const [open, dispatch] = useReducer(expandReducer, false)
  const opener = useRef<HTMLButtonElement>(null)
  const height = props.height ?? (compact ? COMPACT_HEIGHT : FULL_HEIGHT)
  // Focus returns to the Expand button before the dialog unmounts (synchronous, so it also works in a background tab).
  const close = () => { opener.current?.focus(); dispatch('close') }
  return <div className={`card chart-card ${compact ? 'chart-card--compact' : ''} ${className ?? ''}`}>
    <div className="chart-hdr">
      <div className="chart-titles">
        <div className={compact ? 'site-trend-name' : 'ct'} style={titleColor ? { color: titleColor } : undefined}>{title}</div>
        {subtitle && <div className="chart-sub">{subtitle}</div>}
      </div>
      <button ref={opener} type="button" className="expand-btn" onClick={() => dispatch('open')} aria-haspopup="dialog" aria-expanded={open} aria-label={`Expand ${title}`} title="Expand">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M7 1h4v4M5 11H1V7M11 1 7 5M1 11l4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        {!compact && <span>Expand</span>}
      </button>
    </div>
    {headline && <div className="chart-headline">{headline}</div>}
    {legend && legend.length > 1 && <Legend items={legend} />}
    <div className="chart-body" style={{ minHeight: height }}>{chart(height, false)}</div>
    {children}
    {note && <div className="chart-note">{note}</div>}
    {open && <ExpandDialog title={title} titleColor={titleColor} subtitle={subtitle} legend={legend} onClose={close} table={table} csvName={csvName ?? csvFileName(title)} note={note}>{chart(DIALOG_HEIGHT, true)}</ExpandDialog>}
  </div>
}

export function ExpandDialog({ title, titleColor, subtitle, legend, onClose, table, csvName, note, children }: { title: string; titleColor?: string; subtitle?: ReactNode; legend?: LegendItem[]; onClose: () => void; table?: WeeklyTable; csvName: string; note?: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    closeBtn.current?.focus()
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const action = dialogKeyAction(e.key)
    if (action === 'close') { e.preventDefault(); e.stopPropagation(); onClose(); return }
    if (action === 'trap' && ref.current) {
      const focusables = [...ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled'))
      const next = trapFocus(focusables, document.activeElement as HTMLElement | null, e.shiftKey)
      if (next) { e.preventDefault(); next.focus() }
    }
  }
  return <div className="exec-modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
    <div ref={ref} className="exec-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onKeyDown={onKeyDown}>
      <div className="exec-dialog-hdr">
        <div>
          <h2 id={`${id}-title`} style={titleColor ? { color: titleColor } : undefined}>{title}</h2>
          {subtitle && <div className="chart-sub">{subtitle}</div>}
        </div>
        <div className="exec-dialog-actions">
          {table && <button type="button" className="dlg-btn" onClick={() => downloadCsv(csvName, weeklyCsv(table))}>Export CSV</button>}
          <button ref={closeBtn} type="button" className="dlg-btn dlg-close" onClick={onClose} aria-label="Close">Close</button>
        </div>
      </div>
      {legend && legend.length > 1 && <Legend items={legend} />}
      <div className="exec-dialog-chart">{children}</div>
      {note && <div className="chart-note">{note}</div>}
      {table && <div className="tbl tbl--sticky" style={{ marginTop: 14 }}><WeeklyTableView table={table} ariaLabel={`${title} — weekly data`} /></div>}
    </div>
  </div>
}

/** The weekly data table: numeric columns right-aligned in tabular figures, zebra rows, flags as "~est". */
export function WeeklyTableView({ table, ariaLabel }: { table: WeeklyTable; ariaLabel: string }) {
  return <table className="tbl-zebra" aria-label={ariaLabel}>
    <thead><tr>{table.columns.map((c) => <th key={c.key} className={isNumericKind(c.kind) ? 'num' : 'l'}>{c.header}</th>)}</tr></thead>
    <tbody>
      {table.rows.map((r, i) => <tr key={i}>{table.columns.map((c) => { const text = formatCell(c.kind, r[c.key]); return <td key={c.key} className={`${isNumericKind(c.kind) ? 'num' : 'l'} ${c.kind === 'flag' && text ? 'est' : ''}`}>{text}</td> })}</tr>)}
      {!table.rows.length && <tr><td colSpan={table.columns.length} className="neutral l">No weekly data</td></tr>}
    </tbody>
  </table>
}
