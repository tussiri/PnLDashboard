/**
 * The executive chart system: one Chart.js 4 configuration (via react-chartjs-2) for every trend on the
 * Executive Overview, so the cards read as one system.
 *
 * - x axis: month names on the first week of each month only ("May", "Jun", ...), horizontal, with faint
 *   unlabelled week gridlines and a slightly darker one at the month boundary (`monthTicks`).
 * - y axis: one axis per chart, never two. Percent charts use a fixed 0-120 % domain with 5 ticks so every
 *   BU shares the same scale; values beyond it are drawn at the top with a small triangle and the real value in
 *   the tooltip ("above axis"). Dollar charts get a nice-rounded 0-based axis (`niceDollarAxis`).
 * - lines 2 px, tension 0.25, no fill except a 10 % wash under the primary series; bars <= 24 px with rounded
 *   data ends; the in-progress week is hollow (and its segment dashed); the selected week gets a vertical
 *   band and an enlarged point; a target line is dashed and labelled at its right end.
 * - tooltip: week, every series' value, WoW change, basis flags (~est) and any anomaly note.
 * Decorations (band, target label, clamp and anomaly markers) are drawn by an inline plugin that reads the
 * latest props through a ref, so react-chartjs-2 in-place updates stay correct.
 */
import { BarController, BarElement, CategoryScale, Chart as ChartJS, Filler, Legend, LineController, LineElement, LinearScale, PointElement, Tooltip, type ChartData, type ChartDataset, type ChartOptions, type Plugin, type ScriptableContext } from 'chart.js'
import { useMemo, useRef } from 'react'
import { Chart } from 'react-chartjs-2'
import { PCT_DOMAIN, clampSeries, dollarTick, fmtMetric, monthTicks, niceDollarAxis, pctStep, wowText, type ExecMetric } from './charts'
import { weekLabel, withAlpha } from './model'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, LineController, BarController, Filler, Tooltip, Legend)

export const TICK = '#888'
export const GRID = 'rgba(128,128,128,0.10)'
const GRID_WEEK = 'rgba(128,128,128,0.08)'
const GRID_MONTH = 'rgba(128,128,128,0.30)'
const BAND = 'rgba(128,128,128,0.13)'
const TARGET = '#8a8a85'

/** Colours the overview uses for series that are not BU attributes. Validated (dataviz palette checks) against every BU colour. */
export const TOTAL_COLOR = '#378ADD'
export const COST_COLOR = '#6B4FBB'
export const OT_COLOR = '#E8593C'
export const VENDOR_COLOR = '#B7791F'
export const MARGIN_COLOR = '#8a94a6'

export interface ExecSeries {
  id: string
  label: string
  /** One value per period (week or month); null = no data. */
  values: (number | null)[]
  color: string
  kind?: 'line' | 'bar'
  /** The primary series gets the light area wash. */
  primary?: boolean
  dashed?: boolean
  hidden?: boolean
}

export interface ExecChartProps {
  /** ISO Mondays (or ISO first-of-month for a monthly chart). */
  weeks: string[]
  selectedWeek?: string | null
  /** In-progress periods: hollow points / hatched bars, dashed lead-in segment. */
  partialWeeks?: ReadonlySet<string>
  /** Per-period "~est" flag (estimated invoicing / vendor cost) for the tooltip. */
  estimated?: boolean[]
  metric: ExecMetric
  series: ExecSeries[]
  target?: { value: number; label: string }
  height: number
  /** Percent domain top (default 120). */
  pctMax?: number
  /** Dollar domain top: values beyond it are clamped like percentages (see `dollarClampMax`). */
  dollarMax?: number | null
  /** Per-period anomaly note (rendered as a ring on the point and a line in the tooltip). */
  anomalies?: (string | null)[]
  /** Extra tooltip lines for a period (vendor %, hours, ...). */
  extras?: (index: number) => string[]
  /** Hide the x tick labels (the top panel of a stacked pair). */
  showXTicks?: boolean
  /** Fixed y-axis width so stacked panels align. */
  axisWidth?: number
  stacked?: boolean
  /** Tooltip title for a period; defaults to "Week of May 4". */
  periodLabel?: (iso: string) => string
  ariaLabel: string
}

function themeOf(chart: ChartJS) {
  const el = chart.canvas.closest('.exec-pl')
  const cs = el ? getComputedStyle(el) : null
  const get = (name: string, fallback: string) => cs?.getPropertyValue(name).trim() || fallback
  return { surface: get('--bg', '#ffffff'), text3: get('--text3', '#8a8a85'), bad: get('--bad', '#a32d2d') }
}

const patterns = new Map<string, CanvasPattern>()
/** 45° hatch in the series colour on the surface: the projected / in-progress bar. */
function hatch(ctx: CanvasRenderingContext2D, color: string, surface: string): CanvasPattern | string {
  const key = `${color}|${surface}`
  const cached = patterns.get(key)
  if (cached) return cached
  const tile = document.createElement('canvas')
  tile.width = 8; tile.height = 8
  const g = tile.getContext('2d')
  if (!g) return color
  g.fillStyle = surface; g.fillRect(0, 0, 8, 8)
  g.strokeStyle = color; g.lineWidth = 1.5; g.lineCap = 'square'
  g.beginPath(); g.moveTo(-2, 10); g.lineTo(10, -2); g.moveTo(2, 14); g.lineTo(14, 2); g.moveTo(-6, 6); g.lineTo(6, -6); g.stroke()
  const p = ctx.createPattern(tile, 'repeat')
  if (p) patterns.set(key, p)
  return p ?? color
}

interface DecorState {
  selIdx: number
  target?: { value: number; label: string }
  /** Per dataset (chart order) per index: drawn at the domain top (clamped) or bottom (below). */
  clamped: boolean[][]
  below: boolean[][]
  colors: string[]
  hidden: boolean[]
  anomalies: (string | null)[]
  targetIdx: number
}

type Ctx = ScriptableContext<'line' | 'bar'>

export function ExecChart({ weeks, selectedWeek, partialWeeks, estimated, metric, series, target, height, pctMax = PCT_DOMAIN.max, dollarMax, anomalies, extras, showXTicks = true, axisWidth, stacked, periodLabel = weekLabel, ariaLabel }: ExecChartProps) {
  const partial = weeks.map((w) => Boolean(partialWeeks?.has(w)))
  const selIdx = selectedWeek ? weeks.indexOf(selectedWeek) : -1
  const compact = height < 200
  const { labels, boundaries } = monthTicks(weeks, compact ? 3 : 2)
  const boundarySet = new Set(boundaries)
  const hasBars = series.some((s) => s.kind === 'bar')

  const clampAt = metric === 'pct' ? pctMax : dollarMax ?? null
  const none = (s: ExecSeries) => ({ plotted: s.values, clamped: s.values.map(() => false), below: s.values.map(() => false), raw: s.values })
  const prepared = series.map((s) => (clampAt !== null ? clampSeries(s.values, clampAt, metric === 'dollars' ? -clampAt : undefined) : none(s)))
  const datasets: ChartDataset<'line' | 'bar', (number | null)[]>[] = series.map((s, si) => {
    const data = prepared[si].plotted
    if (s.kind === 'bar') {
      const bar: ChartDataset<'bar', (number | null)[]> = {
        type: 'bar', label: s.label, data, hidden: s.hidden, order: 2, maxBarThickness: 24, borderRadius: 4, borderSkipped: 'start',
        backgroundColor: (ctx: Ctx) => (partial[ctx.dataIndex] ? hatch(ctx.chart.ctx, s.color, themeOf(ctx.chart).surface) : withAlpha(s.color, 'CC')),
        borderColor: s.color, borderWidth: (ctx: Ctx) => (partial[ctx.dataIndex] ? 1.5 : 0),
        hoverBackgroundColor: s.color,
      }
      return bar as ChartDataset<'line' | 'bar', (number | null)[]>
    }
    const line: ChartDataset<'line', (number | null)[]> = {
      type: 'line', label: s.label, data, hidden: s.hidden, order: 1, spanGaps: true, tension: 0.25, borderWidth: 2, borderColor: s.color,
      borderDash: s.dashed ? [5, 4] : undefined, backgroundColor: s.primary ? withAlpha(s.color, '1A') : 'transparent', fill: s.primary ? 'origin' : false,
      pointRadius: (ctx: Ctx) => (ctx.dataIndex === selIdx ? 5 : partial[ctx.dataIndex] ? 4 : 2.5), pointHoverRadius: 6, pointHitRadius: 12,
      pointBackgroundColor: (ctx: Ctx) => (partial[ctx.dataIndex] ? themeOf(ctx.chart).surface : s.color), pointBorderColor: s.color,
      pointBorderWidth: (ctx: Ctx) => (partial[ctx.dataIndex] ? 2 : 1),
      segment: { borderDash: (ctx) => (partial[ctx.p1DataIndex] ? [4, 4] : undefined) },
    }
    return line as ChartDataset<'line' | 'bar', (number | null)[]>
  })
  let targetIdx = -1
  if (target) {
    targetIdx = datasets.length
    const t: ChartDataset<'line', (number | null)[]> = { type: 'line', label: target.label, data: weeks.map(() => target.value), borderColor: TARGET, borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0, pointHitRadius: 0, fill: false, order: 3 }
    datasets.push(t as ChartDataset<'line' | 'bar', (number | null)[]>)
  }
  const data: ChartData<'line' | 'bar', (number | null)[], string> = { labels: weeks, datasets }

  // Axis domain: fixed for percentages, nice-rounded for dollars (across every visible series).
  let yMin = 0, yMax = pctMax, step = pctStep(pctMax)
  if (metric === 'dollars') {
    const visible = series.filter((s) => !s.hidden).flatMap((s, si) => prepared[si].plotted.filter((v): v is number => v !== null))
    const axis = niceDollarAxis(Math.min(0, ...visible), Math.max(0, ...visible, target?.value ?? 0))
    yMin = axis.min; yMax = axis.max; step = axis.step
  }

  const state = useRef<DecorState>({ selIdx, target, clamped: [], below: [], colors: [], hidden: [], anomalies: [], targetIdx })
  state.current = { selIdx, target, clamped: prepared.map((p) => p.clamped), below: prepared.map((p) => p.below), colors: series.map((s) => s.color), hidden: series.map((s) => Boolean(s.hidden)), anomalies: anomalies ?? [], targetIdx }
  const decor = useMemo<Plugin<'line' | 'bar'>>(() => ({
    id: 'execDecor',
    beforeDatasetsDraw(chart) {
      const { selIdx: sel } = state.current
      const x = chart.scales.x
      if (sel < 0 || !x) return
      const n = Math.max(1, chart.data.labels?.length ?? 1)
      const half = (x.width / n) / 2
      const cx = x.getPixelForValue(sel)
      const { top, bottom } = chart.chartArea
      const g = chart.ctx
      g.save(); g.fillStyle = BAND; g.fillRect(cx - half, top, half * 2, bottom - top); g.restore()
    },
    afterDatasetsDraw(chart) {
      const st = state.current
      const { x, y } = chart.scales
      if (!x || !y) return
      const g = chart.ctx
      const th = themeOf(chart)
      const { top, right, left, bottom } = chart.chartArea
      g.save()
      if (st.target) {
        const ty = y.getPixelForValue(st.target.value)
        if (ty >= top && ty <= chart.chartArea.bottom) {
          g.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
          g.fillStyle = th.text3; g.textAlign = 'right'; g.textBaseline = 'bottom'
          g.fillText(st.target.label, right - 2, ty - 3)
        }
      }
      st.clamped.forEach((flags, di) => {
        if (st.hidden[di]) return
        flags.forEach((isClamped, i) => {
          if (!isClamped) return
          const px = x.getPixelForValue(i)
          g.fillStyle = st.colors[di]
          g.beginPath(); g.moveTo(px, top - 12); g.lineTo(px - 4, top - 4); g.lineTo(px + 4, top - 4); g.closePath(); g.fill()
        })
        st.below[di]?.forEach((isBelow, i) => {
          if (!isBelow) return
          const px = x.getPixelForValue(i)
          g.fillStyle = st.colors[di]
          g.beginPath(); g.moveTo(px, bottom + 3); g.lineTo(px - 4, bottom - 5); g.lineTo(px + 4, bottom - 5); g.closePath(); g.fill()
        })
      })
      st.anomalies.forEach((note, i) => {
        if (!note) return
        const px = x.getPixelForValue(i)
        let py = Number.POSITIVE_INFINITY
        chart.data.datasets.forEach((ds, di) => {
          if (di === st.targetIdx || st.hidden[di] || !chart.isDatasetVisible(di)) return
          const v = ds.data[i]
          if (typeof v === 'number') py = Math.min(py, y.getPixelForValue(v))
        })
        if (!Number.isFinite(py)) return
        g.strokeStyle = th.bad; g.lineWidth = 1.5
        g.beginPath(); g.arc(Math.min(Math.max(px, left), right), py, 7, 0, Math.PI * 2); g.stroke()
      })
      g.restore()
    },
  }), [])

  const options: ChartOptions<'line' | 'bar'> = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 160 },
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 14, right: 6, left: 0, bottom: 0 } },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(26,26,24,0.94)', titleFont: { size: 12, weight: 600 }, bodyFont: { size: 12 }, footerFont: { size: 11, weight: 'normal' }, padding: 10,
        boxWidth: 10, boxHeight: 2, boxPadding: 4, cornerRadius: 6, displayColors: true,
        filter: (item) => item.datasetIndex !== targetIdx,
        callbacks: {
          title: (items) => { const i = items[0]?.dataIndex ?? 0; return `${periodLabel(weeks[i] ?? '')}${partial[i] ? ' · in progress' : ''}` },
          label: (c) => {
            const s = series[c.datasetIndex]
            if (!s) return ''
            const raw = s.values[c.dataIndex] ?? null
            const prev = c.dataIndex > 0 ? s.values[c.dataIndex - 1] ?? null : null
            const wow = wowText(metric, raw, prev)
            const above = prepared[c.datasetIndex]?.clamped[c.dataIndex] ? ' (above axis)' : prepared[c.datasetIndex]?.below[c.dataIndex] ? ' (below axis)' : ''
            return ` ${s.label}: ${fmtMetric(metric, raw)}${above}${wow ? ` · ${wow}` : ''}`
          },
          afterBody: (items) => {
            const i = items[0]?.dataIndex ?? -1
            if (i < 0) return []
            const lines = [...(extras?.(i) ?? [])]
            if (estimated?.[i]) lines.push('~est · estimated values in this week')
            const note = anomalies?.[i]
            if (note) lines.push(`⚠ ${note}`)
            return lines
          },
        },
      },
    },
    scales: {
      x: {
        stacked: Boolean(stacked), offset: hasBars,
        ticks: { display: showXTicks, color: TICK, font: { size: compact ? 10 : 11 }, autoSkip: false, maxRotation: 0, minRotation: 0, padding: 4, callback: (_v, i) => labels[i] ?? '' },
        grid: { color: (ctx) => (boundarySet.has(ctx.index) ? GRID_MONTH : GRID_WEEK), drawTicks: false }, border: { display: false },
      },
      y: {
        stacked: Boolean(stacked), min: yMin, max: yMax,
        ticks: { stepSize: step, color: TICK, font: { size: compact ? 10 : 11 }, maxTicksLimit: compact ? 4 : 6, padding: 4, callback: (v) => (metric === 'pct' ? `${v}%` : dollarTick(Number(v))) },
        grid: { color: GRID, drawTicks: false }, border: { display: false },
        afterFit: axisWidth ? (scale) => { scale.width = axisWidth } : undefined,
      },
    },
  }

  return <div className="cw" style={{ height }} role="img" aria-label={ariaLabel}>
    <Chart type={hasBars ? 'bar' : 'line'} data={data} options={options} plugins={[decor]} />
  </div>
}

/** Bar chart for categorical comparisons (OT hours by site, OT % by site): horizontal bars with the same chrome. */
export function CategoryBars({ labels, values, colors, format, height, ariaLabel, valueMax }: { labels: string[]; values: number[]; colors: string[]; format: (v: number) => string; height: number; ariaLabel: string; valueMax?: number }) {
  const data: ChartData<'bar', number[], string> = { labels, datasets: [{ data: values, backgroundColor: colors.map((c) => withAlpha(c, 'CC')), hoverBackgroundColor: colors, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 24 }] }
  const options: ChartOptions<'bar'> = {
    indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: { duration: 160 },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(26,26,24,0.94)', padding: 10, cornerRadius: 6, displayColors: false, callbacks: { label: (c) => ` ${format(Number(c.raw))}` } } },
    scales: {
      x: { min: 0, max: valueMax, ticks: { color: TICK, font: { size: 11 }, maxTicksLimit: 6, callback: (v) => format(Number(v)) }, grid: { color: GRID, drawTicks: false }, border: { display: false } },
      y: { ticks: { color: TICK, font: { size: 11 }, autoSkip: false }, grid: { display: false }, border: { display: false } },
    },
  }
  return <div className="cw" style={{ height }} role="img" aria-label={ariaLabel}><Chart type="bar" data={data} options={options} /></div>
}
