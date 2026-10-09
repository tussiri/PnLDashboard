/**
 * The Company story's charts. Drawn as SVG and HTML rather than Chart.js: canvas marks cannot carry the CSS
 * motion (leadership.css, "Company story"), which is keyed off classes on each mark and a `--story-delay`
 * for the stagger. It only runs while an ancestor carries `data-reveal="play"`, so a re-render, a resize or
 * a return to the page draws the chart still. Colors are the theme tokens, so light and dark both hold.
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { GLOSSARY, type GlossaryKey } from './glossary'

const delay = (ms: number) => ({ '--story-delay': `${ms}ms` }) as CSSProperties

/** The element's content width, followed through resizes. */
function useWidth<T extends HTMLElement>(fallback = 560) {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth || fallback)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.round(entry.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [fallback])
  return [ref, width] as const
}

/** Round axis steps: 1, 2, 2.5 or 5 times a power of ten, about `count` of them up to `max`. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0]
  const raw = max / count
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw
  const ticks = []
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v)
  if (ticks.at(-1)! < max) ticks.push(ticks.at(-1)! + step)
  return ticks
}

/** Round ticks covering min to max, zero included. */
export function niceRange(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min, min + 1]
  const step = niceTicks(max - min, count)[1] ?? 1
  const ticks = []
  for (let v = Math.floor(min / step) * step; v < max + step * 0.999; v += step) ticks.push(Math.round(v / step) * step)
  return ticks
}

/** A label with its definition on hover and keyboard focus. */
export function MetricLabel({ metric, label }: { metric: GlossaryKey; label?: string }) {
  const id = useId()
  const d = GLOSSARY[metric]
  return <span className="ml" tabIndex={0} aria-describedby={id}>
    {label ?? d.term}
    <span role="tooltip" id={id} className="ml__tip">
      <b>{d.term}</b> {d.definition}
      {'formula' in d && d.formula ? <code>{d.formula}</code> : null}
      {'caveat' in d && d.caveat ? <span className="ml__cv">{d.caveat}</span> : null}
    </span>
  </span>
}

function Tip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x, 70), width - 70)
  return <div className="stip" style={{ left, top: y }} role="status">{children}</div>
}

// --- Vertical bars by month -------------------------------------------------------

export interface MonthBar { key: string; label: string; value: number; muted?: boolean; tip: ReactNode }

const PAD = { top: 10, right: 6, bottom: 22, left: 48 }

/** Monthly bars that grow from the baseline, staggered left to right. */
export function MonthBars({ bars, format, caption, height = 230 }: { bars: MonthBar[]; format: (v: number) => string; caption: string; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const ticks = niceTicks(Math.max(0, ...bars.map((b) => b.value)))
  const top = ticks.at(-1) || 1
  const plotW = width - PAD.left - PAD.right
  const plotH = height - PAD.top - PAD.bottom
  const band = plotW / Math.max(1, bars.length)
  const barW = Math.min(36, band * 0.68)
  const y = (v: number) => PAD.top + plotH - (Math.max(0, v) / top) * plotH
  const baseline = PAD.top + plotH
  return <figure className="sfig" ref={ref} onMouseLeave={() => setHover(null)}>
    <svg width={width} height={height} role="img" aria-label={caption} className="ssvg">
      {ticks.map((t) => <g key={t}>
        <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="sgridline" />
        <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end">{format(t)}</text>
      </g>)}
      {bars.map((b, i) => {
        const x = PAD.left + band * i + (band - barW) / 2
        const h = baseline - y(b.value)
        return <g key={b.key} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} aria-label={`${b.label}: ${format(b.value)}`}>
          <rect x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} fill="transparent" />
          {h > 0 && <rect x={x} y={y(b.value)} width={barW} height={h} rx={2} className={`story-grow-y ${b.muted ? 'sbar-muted' : 'sbar'}${hover === i ? ' on' : ''}`}
            style={{ ...delay(Math.min(i * 45, 540)), transformOrigin: `0px ${baseline}px` }} />}
          {(band >= 30 || i % 2 === (bars.length - 1) % 2) && <text x={PAD.left + band * (i + 0.5)} y={height - 6} textAnchor="middle">{b.label}</text>}
        </g>
      })}
    </svg>
    {hover != null && bars[hover] && <Tip x={PAD.left + band * (hover + 0.5)} y={y(bars[hover].value) - 8} width={width}>{bars[hover].tip}</Tip>}
  </figure>
}

// --- Horizontal bars --------------------------------------------------------------

export interface StoryBarRow {
  key: string
  label: string
  value: number
  /** The value as written beside the bar. */
  display: string
  /** A second figure, e.g. a share or a margin. */
  detail?: string
  /** Bar color class: the row the figures are about is `sbar`; the rest `sbar-muted`; status tones `ok`, `warn`, `bad`. */
  tone?: 'sbar' | 'sbar-muted' | 'ok' | 'warn' | 'bad'
  /** A target tick, on the same scale as `value`. */
  marker?: number
  tip?: string
}

/** Horizontal bars that grow from the left, staggered top to bottom, each value written at the bar's end. */
export function StoryBars({ rows, max, caption }: { rows: StoryBarRow[]; max?: number; caption: string }) {
  const top = Math.max(1e-9, max ?? Math.max(0, ...rows.map((r) => Math.max(r.value, r.marker ?? 0))))
  const at = (v: number) => `calc((100% - 9.5rem) * ${Math.max(0, Math.min(1, v / top))})`
  return <figure className="sfig">
    <ol className="sbars">
      {rows.map((r, i) => <li key={r.key} title={r.tip}>
        <span className="sbars__l">{r.label}</span>
        <span className="sbars__t">
          <span role="img" aria-label={`${r.label}: ${r.display}${r.detail ? `, ${r.detail}` : ''}`} className={`story-grow-x sbars__b ${r.tone ?? 'sbar'}`}
            style={{ ...delay(Math.min(i * 80, 640)), width: at(r.value) }} />
          {r.marker != null && <i className="sbars__m story-fade-in" style={{ ...delay(400), left: at(r.marker) }} aria-hidden="true" />}
          <span className="sbars__v story-fade-in" style={delay(450 + Math.min(i * 80, 640))}>
            <b>{r.display}</b>{r.detail ? <small>{r.detail}</small> : null}
          </span>
        </span>
      </li>)}
    </ol>
    <figcaption className="sr-only">{caption}</figcaption>
  </figure>
}

// --- Line over a faded area -------------------------------------------------------

export interface LinePoint { key: string; label: string; value: number; band?: number; tip: ReactNode }

/** A line drawn left to right over a faded area (a second series, e.g. budget), then its points and end label. */
export function StoryLine({ points, format, caption, endLabel, height = 230 }: {
  points: LinePoint[]; format: (v: number) => string; caption: string; endLabel?: string; height?: number
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const gradient = useId().replace(/:/g, '')
  const values = points.flatMap((p) => [p.value, p.band ?? p.value])
  const ticks = niceRange(Math.min(0, ...values), Math.max(0, ...values))
  const min = ticks[0], max = ticks.at(-1)!
  const pad = { ...PAD, right: endLabel ? 18 : 10 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const x = (i: number) => pad.left + (points.length > 1 ? (plotW * i) / (points.length - 1) : plotW / 2)
  const y = (v: number) => pad.top + plotH - ((v - min) / (max - min || 1)) * plotH
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join('')
  const banded = points.every((p) => p.band != null)
  const area = banded ? `${points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.band!)}`).join('')}L${x(points.length - 1)},${y(min)}L${x(0)},${y(min)}Z` : ''
  const bandLine = banded ? points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.band!)}`).join('') : ''
  const last = points.length - 1
  const step = Math.ceil(points.length / Math.max(2, Math.floor(plotW / 48)))
  return <figure className="sfig" ref={ref} onMouseLeave={() => setHover(null)}>
    <svg width={width} height={height} role="img" aria-label={caption} className="ssvg">
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="var(--muted)" stopOpacity={0.9} /><stop offset="100%" stopColor="var(--muted)" stopOpacity={0.15} />
      </linearGradient></defs>
      {ticks.map((t) => <g key={t}>
        <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className={t === 0 && min < 0 ? 'szero' : 'sgridline'} />
        <text x={pad.left - 6} y={y(t)} dy="0.32em" textAnchor="end">{format(t)}</text>
      </g>)}
      {banded && <path d={area} fill={`url(#${gradient})`} className="story-fade-in" style={delay(150)} />}
      {banded && <path d={bandLine} className="sband story-fade-in" style={delay(150)} />}
      <path d={line} pathLength={1} className="sline story-draw" />
      {points.map((p, i) => <g key={p.key} className="story-fade-in" style={delay(900 + Math.min(i * 60, 700))}>
        <circle cx={x(i)} cy={y(p.value)} r={i === last || hover === i ? 4 : 2.5} className="sdot" />
        {i % step === 0 || i === last ? <text x={x(i)} y={height - 6} textAnchor="middle">{p.label}</text> : null}
      </g>)}
      {endLabel && points.length > 0 && <text x={x(last) - 6} y={y(points[last].value) - 10} textAnchor="end" className="send story-fade-in" style={delay(1500)}>{endLabel}</text>}
      {points.map((p, i) => <rect key={p.key} x={x(i) - plotW / Math.max(1, points.length) / 2} y={pad.top} width={plotW / Math.max(1, points.length)} height={plotH}
        fill="transparent" tabIndex={0} aria-label={`${p.label}: ${format(p.value)}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />)}
    </svg>
    {hover != null && points[hover] && <Tip x={x(hover)} y={y(points[hover].value) - 10} width={width}>{points[hover].tip}</Tip>}
  </figure>
}

// --- 100 squares ------------------------------------------------------------------

export interface SquareGroup { key: string; label: string; squares: number; color: string; detail?: string }

/** One square per dollar of 100, filled in reading order, popping in one after another. */
export function SquareGrid({ groups, caption }: { groups: SquareGroup[]; caption: string }) {
  const cells = groups.flatMap((g) => Array.from({ length: g.squares }, () => g))
  return <figure className="sfig">
    <div role="img" aria-label={`${caption}: ${groups.map((g) => `${g.squares} ${g.label.toLowerCase()}`).join(', ')}`} className="sgrid">
      {cells.map((g, i) => <i key={i} aria-hidden="true" title={g.label} className="story-pop" style={{ ...delay(i * 12), background: g.color }} />)}
    </div>
    <ul className="sgrid__k">
      {groups.map((g) => <li key={g.key}>
        <i aria-hidden="true" style={{ background: g.color }} />
        <b>${g.squares}</b><span>{g.label}</span>{g.detail ? <small>{g.detail}</small> : null}
      </li>)}
    </ul>
  </figure>
}
