import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { monthLabel } from '../services/period'

/** Restrained series palette (CSS tokens defined in styles.css). */
export const series = {
  primary: 'var(--blue)', primarySoft: 'var(--blue-soft)', secondary: 'var(--purple)', good: 'var(--green)', warn: 'var(--amber)', bad: 'var(--red)',
  navy: 'var(--navy)', teal: 'var(--teal)', muted: '#b6c0d0', grid: 'var(--grid)', text: 'var(--text)', mutedText: 'var(--muted)',
}
export const categorical = ['var(--blue)', 'var(--purple)', 'var(--teal)', 'var(--amber)', 'var(--green)', 'var(--navy)', 'var(--red)', '#8a94a6']

export const xAxisProps = { tickLine: false, axisLine: false, tick: { fill: 'var(--muted)', fontSize: 11 }, minTickGap: 18 } as const
export const yAxisProps = { tickLine: false, axisLine: false, tick: { fill: 'var(--muted)', fontSize: 11 }, width: 56 } as const
export const gridProps = { vertical: false, stroke: 'var(--grid)' } as const
export const monthTick = (iso: string) => monthLabel(iso, 'tick')
export const barLabel = { position: 'right' as const, fill: 'var(--text)', fontSize: 10, fontVariantNumeric: 'tabular-nums' }

type TooltipItem = { name?: string | number; value?: unknown; color?: string; dataKey?: string | number; payload?: Record<string, unknown>; hide?: boolean }
export type TooltipFormatter = (value: unknown, name: string, item: TooltipItem) => [string, string] | null

export interface ChartTooltipProps {
  active?: boolean
  payload?: ReadonlyArray<TooltipItem>
  label?: unknown
  formatter?: TooltipFormatter
  labelFormatter?: (label: unknown, payload?: ReadonlyArray<TooltipItem>) => ReactNode
  footer?: (payload: ReadonlyArray<TooltipItem>) => ReactNode
}

/** Unified tooltip: header label, one row per visible series, tabular numbers. Pass as `content={<ChartTooltip .../>}`. */
export function ChartTooltip({ active, payload, label, formatter, labelFormatter, footer }: ChartTooltipProps) {
  if (!active || !payload?.length) return null
  const visible = payload.filter((item) => !item.hide && item.value !== undefined && item.value !== null)
  if (!visible.length) return null
  const heading = labelFormatter ? labelFormatter(label, payload) : typeof label === 'string' && /^\d{4}-\d{2}-01$/.test(label) ? monthLabel(label) : label === undefined ? null : String(label)
  return (
    <div className="chart-tip" role="status">
      {heading !== null && heading !== '' && <div className="chart-tip__label">{heading}</div>}
      {visible.map((item, index) => {
        const name = String(item.name ?? item.dataKey ?? '')
        const formatted = formatter ? formatter(item.value, name, item) : [String(item.value), name]
        if (!formatted) return null
        return <div className="chart-tip__row" key={`${name}-${index}`}><i style={{ background: item.color ?? 'var(--muted)' }} /><span>{formatted[1]}</span><b>{formatted[0]}</b></div>
      })}
      {footer && <div className="chart-tip__footer">{footer(payload)}</div>}
    </div>
  )
}

export interface LegendSeries { key: string; name: string; color: string; kind?: 'line' | 'bar' | 'area' | 'dash' }

/** Legend with click-to-toggle. Returns a `hidden` set to drive `hide` props on Recharts series. */
export function useSeriesToggle(initialHidden: string[] = []) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(initialHidden))
  const toggle = useCallback((key: string) => setHidden((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next }), [])
  const isHidden = useCallback((key: string) => hidden.has(key), [hidden])
  return useMemo(() => ({ hidden, toggle, isHidden }), [hidden, toggle, isHidden])
}

export function LegendToggles({ series: items, hidden, onToggle, align = 'right' }: { series: LegendSeries[]; hidden?: Set<string>; onToggle?: (key: string) => void; align?: 'left' | 'right' }) {
  return (
    <div className={`chart-legend chart-legend--${align}`} role="group" aria-label="Series">
      {items.map((item) => {
        const off = hidden?.has(item.key)
        const content = <><i className={`chart-legend__swatch chart-legend__swatch--${item.kind ?? 'line'}`} style={{ color: item.color }} /><span>{item.name}</span></>
        return onToggle ? <button type="button" key={item.key} className={off ? 'is-off' : ''} aria-pressed={!off} onClick={() => onToggle(item.key)}>{content}</button> : <span key={item.key} className="chart-legend__static">{content}</span>
      })}
    </div>
  )
}

/** Small inline progress-style bar used for direct value labels in tables. */
export function InlineBar({ value, max, color = 'var(--blue)', label }: { value: number; max: number; color?: string; label?: string }) {
  const width = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  return <span className="inline-bar" aria-hidden="true"><i style={{ width: `${width}%`, background: color }} />{label && <em>{label}</em>}</span>
}
