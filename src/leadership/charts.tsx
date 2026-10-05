/**
 * Chart.js charts in the reference dashboard's style: one axis per chart, thin rounded bars, a dashed
 * target line, recessive gridlines, colors read from the CSS tokens so light and dark themes each get
 * their own steps. Every chart sits in a ChartCard with a table view of the same numbers.
 */
import { BarController, BarElement, CategoryScale, Chart as ChartJS, Filler, Legend, LinearScale, LineController, LineElement, PointElement, Tooltip, type ChartData, type ChartOptions } from 'chart.js'
import { useEffect, useState } from 'react'
import { Bar, Chart, Line } from 'react-chartjs-2'
import { hours as fmtHours, money, pct } from './format'
import { useLeadership } from './state'

ChartJS.register(BarController, BarElement, CategoryScale, LinearScale, LineController, LineElement, PointElement, Tooltip, Legend, Filler)

export interface Tokens { text: string; text2: string; text3: string; border: string; ok: string; warn: string; bad: string; accent: string; accent2: string; muted: string; bg: string; tgt: string
  /** Categorical series colors (--s1..--s6), for one line per group. */
  series: string[] }

function readTokens(): Tokens {
  const css = getComputedStyle(document.documentElement)
  const v = (n: string) => css.getPropertyValue(n).trim()
  return { text: v('--text'), text2: v('--text2'), text3: v('--text3'), border: v('--border'), ok: v('--ok'), warn: v('--warn'), bad: v('--bad'), accent: v('--accent'), accent2: v('--accent2'), muted: v('--muted'), bg: v('--bg'), tgt: v('--tgt'),
    series: [1, 2, 3, 4, 5, 6].map((i) => v(`--s${i}`)) }
}

/** Token colors, re-read when the theme or the system color scheme changes. */
export function useTokens(): Tokens {
  const { theme } = useLeadership()
  const [tokens, setTokens] = useState<Tokens>(readTokens)
  useEffect(() => {
    setTokens(readTokens())
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    const onChange = () => setTokens(readTokens())
    mq?.addEventListener?.('change', onChange)
    return () => mq?.removeEventListener?.('change', onChange)
  }, [theme])
  return tokens
}

export const statusColor = (t: Tokens, tone: 'ok' | 'warn' | 'bad' | 'neutral') => (tone === 'neutral' ? t.text3 : t[tone])

function base(t: Tokens): ChartOptions<'bar'> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    font: { family: getComputedStyle(document.body).fontFamily, size: 11 },
    color: t.text2,
    plugins: { legend: { display: false }, tooltip: { backgroundColor: t.bg, titleColor: t.text, bodyColor: t.text2, borderColor: t.border, borderWidth: 1, padding: 8, boxPadding: 4 } },
    scales: {
      x: { grid: { color: t.border }, border: { display: false }, ticks: { color: t.text2 } },
      y: { grid: { color: t.border }, border: { display: false }, ticks: { color: t.text2 } },
    },
  } as ChartOptions<'bar'>
}

/**
 * A percent axis that ignores outliers: when the largest value is far above the bulk (summer weeks with a
 * tiny invoice reach thousands of percent), the axis tops out at twice the median, never below
 * `floor`, and those points run off the chart (the table view shows them). Undefined when nothing is that far out.
 */
export function pctAxisMax(values: (number | null | undefined)[], floor: number): number | undefined {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return undefined
  const cap = Math.ceil(Math.max(v[Math.floor((v.length - 1) / 2)] * 2, floor) / 20) * 20
  return v[v.length - 1] > cap ? cap : undefined
}

const bar = { borderRadius: 4, borderSkipped: 'start' as const, maxBarThickness: 24, categoryPercentage: 0.7, barPercentage: 0.9 }

/** Labor % by group over time: one line per group in its series color, the selected point enlarged; each group's
 * target dashed in its color (one line when all share it), or the account's budget target as the green stepped line. */
export function SegmentTrendChart({ labels, series, current, budgetTargets, onPick }: {
  labels: string[]; series: { name: string; values: (number | null)[]; target: number }[]; current: number
  budgetTargets?: (number | null)[]; onPick?: (index: number) => void
}) {
  const t = useTokens()
  const o = base(t) as unknown as ChartOptions<'line'>
  const color = (i: number) => t.series[i % t.series.length]
  const sharedTarget = series.every((s) => s.target === series[0]?.target)
  const point = labels.map((_, j) => (j === current ? 5 : 2.5))
  const yMax = pctAxisMax([...series.flatMap((s) => s.values), ...(budgetTargets ?? [])].map((v) => (v == null ? null : v * 100)), Math.max(...series.map((s) => s.target * 100), 100))
  const data = { labels, datasets: [
    ...series.map((s, i) => ({ label: s.name, data: s.values.map((v) => (v == null ? null : v * 100)), borderColor: color(i), backgroundColor: color(i),
      borderWidth: 2, pointRadius: point, pointHoverRadius: 6, pointBorderColor: t.bg, pointBorderWidth: 1.5, tension: 0, spanGaps: true })),
    ...(budgetTargets
      ? [{ label: 'Budget target', data: budgetTargets.map((v) => (v == null ? null : v * 100)), borderColor: t.tgt, backgroundColor: t.tgt, borderWidth: 3,
        stepped: 'middle' as const, pointRadius: 0, pointHitRadius: 0 }]
      : sharedTarget
        ? [{ label: 'Target', data: labels.map(() => (series[0]?.target ?? 0) * 100), borderColor: t.text2, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, pointHitRadius: 0 }]
        : series.map((s, i) => ({ label: `${s.name} target`, data: labels.map(() => s.target * 100), borderColor: color(i), borderDash: [5, 4], borderWidth: 1, pointRadius: 0, pointHitRadius: 0 }))),
  ] }
  const options = { ...o, interaction: { mode: 'index', intersect: false },
    onClick: (_e: unknown, els: { index: number }[]) => { if (onPick && els.length) onPick(els[0].index) },
    onHover: (e: { native?: { target?: EventTarget | null } }, els: unknown[]) => { const el = e.native?.target as HTMLElement | null; if (el && onPick) el.style.cursor = els.length ? 'pointer' : 'default' },
    scales: { x: { ...o.scales!.x, grid: { display: false } }, y: { ...o.scales!.y, beginAtZero: true, max: yMax, ticks: { color: t.text2, callback: (v: string | number) => `${v}%` } } },
    plugins: { ...o.plugins, tooltip: { ...o.plugins!.tooltip, callbacks: { label: (c: { dataset: { label?: string }; parsed: { y: number | null } }) => `${c.dataset.label}: ${c.parsed.y == null ? 'no billing' : `${c.parsed.y.toFixed(1)}%`}` } } } }
  return <Line data={data} options={options as unknown as ChartOptions<'line'>} aria-label={`Labor % by group: ${series.map((s) => s.name).join(', ')}`} role="img" />
}

/** Horizontal paired bars: weekly invoice against cost (labor, plus vendor under cost %). */
export function MixChart({ labels, invoice, cost, costLabel }: { labels: string[]; invoice: number[]; cost: number[]; costLabel: string }) {
  const t = useTokens()
  const o = base(t)
  const data = { labels, datasets: [
    { label: 'Invoicing', data: invoice, backgroundColor: t.accent2, ...bar },
    { label: costLabel, data: cost, backgroundColor: t.accent, ...bar },
  ] }
  const options: ChartOptions<'bar'> = { ...o, indexAxis: 'y',
    scales: { x: { ...o.scales!.x, ticks: { color: t.text2, callback: (v) => `$${Number(v) / 1000}K` } }, y: { ...o.scales!.y, grid: { display: false } } },
    plugins: { ...o.plugins, tooltip: { ...o.plugins!.tooltip, callbacks: { label: (c) => `${c.dataset.label}: ${money(c.parsed.x)}` } } } }
  return <Bar data={data} options={options} aria-label={`Invoicing and ${costLabel.toLowerCase()} by group`} role="img" />
}

/** Horizontal bars of OT hours; unbilled jobs muted, high OT share in the bad tone. */
export function OtHoursChart({ labels, values, tones, details }: { labels: string[]; values: number[]; tones: ('warn' | 'bad' | 'muted')[]; details: string[] }) {
  const t = useTokens()
  const o = base(t)
  const data = { labels, datasets: [{ label: 'OT hours', data: values, backgroundColor: tones.map((x) => (x === 'muted' ? t.muted : t[x])), ...bar }] }
  const options: ChartOptions<'bar'> = { ...o, indexAxis: 'y',
    scales: { x: { ...o.scales!.x, title: { display: true, text: 'OT hours', color: t.text3 } }, y: { ...o.scales!.y, grid: { display: false } } },
    plugins: { ...o.plugins, tooltip: { ...o.plugins!.tooltip, callbacks: { label: (c) => details[c.dataIndex] ?? `${fmtHours(c.parsed.x)} OT hours` } } } }
  return <Bar data={data} options={options} aria-label="OT hours by site" role="img" />
}

/** Weekly measure % trend against the target (one axis, percent). */
export function TrendChart({ labels, values, target, label, targets }: { labels: string[]; values: (number | null)[]; target: number; label: string
  /** Each week's budget target (the account's weekly budget calendar): the green stepped line in place of the flat target. */
  targets?: (number | null)[] }) {
  const t = useTokens()
  const o = base(t) as unknown as ChartOptions<'line'>
  const data = { labels, datasets: [
    { label, data: values.map((v) => (v == null ? null : v * 100)), borderColor: t.accent, backgroundColor: t.accent, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5, pointBorderColor: t.bg, pointBorderWidth: 2, spanGaps: false, tension: 0 },
    targets
      ? { label: 'Weekly budget target', data: targets.map((v) => (v == null ? null : v * 100)), borderColor: t.tgt, backgroundColor: t.tgt, borderWidth: 3, stepped: 'middle' as const,
        pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: t.tgt, pointBorderColor: t.bg, pointBorderWidth: 1.5 }
      : { label: 'Target', data: labels.map(() => target * 100), borderColor: t.text, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, pointHitRadius: 0 },
  ] }
  // A budget week whose invoice is tiny (school out) can target thousands of percent; keep the axis on the site's own range
  // and let that stretch run off the top (the table shows it).
  const top = Math.max(target * 100, ...values.filter((v): v is number => v != null).map((v) => v * 100))
  const capped = targets?.some((v) => v != null && v * 100 > top * 2) ? Math.ceil((top * 1.3) / 20) * 20 : undefined
  const options: ChartOptions<'line'> = { ...o,
    interaction: { mode: 'index', intersect: false },
    scales: { x: { ...o.scales!.x, grid: { display: false } }, y: { ...o.scales!.y, beginAtZero: true, max: capped, ticks: { color: t.text2, callback: (v) => `${v}%` } } },
    plugins: { ...o.plugins, tooltip: { ...o.plugins!.tooltip, callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y == null ? 'no billing' : `${c.parsed.y.toFixed(1)}%`}` } } } }
  return <Line data={data} options={options} aria-label={`${label} by week against a ${pct(target)} target`} role="img" />
}

/** One site's weeks: worked, OT premium and sub hours stacked, against the allowance at target. */
export function CutTrendChart({ labels, worked, premium, sub, allowance, subLabel }: {
  labels: string[]; worked: (number | null)[]; premium: (number | null)[]; sub: (number | null)[]; allowance: (number | null)[]; subLabel: string
}) {
  const t = useTokens()
  const o = base(t)
  const stack = { ...bar, borderRadius: 0, stack: 'hours' }
  const data = { labels, datasets: [
    { type: 'bar' as const, label: 'Worked', data: worked, backgroundColor: t.accent2, ...stack },
    { type: 'bar' as const, label: 'OT premium', data: premium, backgroundColor: t.warn, ...stack },
    { type: 'bar' as const, label: subLabel, data: sub, backgroundColor: t.muted, ...stack },
    { type: 'line' as const, label: 'Allowance', data: allowance, borderColor: t.text, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, pointHitRadius: 6, spanGaps: true },
  ] } as unknown as ChartData<'bar'>
  const options: ChartOptions<'bar'> = { ...o,
    interaction: { mode: 'index', intersect: false },
    scales: { x: { ...o.scales!.x, stacked: true, grid: { display: false } }, y: { ...o.scales!.y, stacked: true, beginAtZero: true, title: { display: true, text: 'Hours', color: t.text3 } } },
    plugins: { ...o.plugins, tooltip: { ...o.plugins!.tooltip, callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y == null ? '–' : fmtHours(c.parsed.y)} h` } } } }
  return <Chart type="bar" data={data} options={options} aria-label="Hours worked, OT premium and sub hours by week against the allowance" role="img" />
}

const tone = (t: Tokens, x: 'ok' | 'warn' | 'bad' | 'neutral') => (x === 'neutral' ? t.muted : t[x])

/** Labor % by site, worst first, colored by status, with the target line (the FedEx report's site chart). */
export function SiteLpChart({ labels, values, tones, target, details }: { labels: string[]; values: (number | null)[]; tones: ('ok' | 'warn' | 'bad' | 'neutral')[]; target: number; details: string[] }) {
  const t = useTokens()
  const o = base(t)
  const data = { labels, datasets: [
    { type: 'bar' as const, label: 'Labor %', data: values.map((v) => (v == null ? null : v * 100)), backgroundColor: tones.map((x) => tone(t, x)), ...bar, maxBarThickness: 14 },
    { type: 'line' as const, label: 'Target', data: labels.map(() => target * 100), borderColor: t.text, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, pointHitRadius: 0 },
  ] } as unknown as ChartData<'bar'>
  const options: ChartOptions<'bar'> = { ...o, indexAxis: 'y',
    scales: { x: { ...o.scales!.x, beginAtZero: true, ticks: { color: t.text2, callback: (v) => `${v}%` } }, y: { ...o.scales!.y, grid: { display: false }, ticks: { color: t.text2, autoSkip: false, font: { size: 10 } } } },
    plugins: { ...o.plugins, tooltip: { ...o.plugins!.tooltip, callbacks: { label: (c) => (c.datasetIndex ? `Target ${pct(target)}` : details[c.dataIndex] ?? '') } } } }
  return <Chart type="bar" data={data} options={options} aria-label={`Labor % by site against a ${pct(target)} target`} role="img" />
}

/** QA score against budget variance by site: bars are labor vs budget dollars (colored by the QA score, edged by
 * group), diamonds the QA score on the right axis, with the pass and warn lines. */
export function QaVarianceChart({ labels, variance, scores, groups, pass, warn }: { labels: string[]; variance: (number | null)[]; scores: (number | null)[]; groups: string[]; pass: number; warn: number }) {
  const t = useTokens()
  const o = base(t)
  const qaTone = (v: number | null) => (v == null ? t.text3 : v >= pass ? t.ok : v >= warn ? t.warn : t.bad)
  const edge = [t.accent, t.accent2, t.tgt, t.muted]
  const groupNames = [...new Set(groups)]
  const data = { labels, datasets: [
    { type: 'bar' as const, label: 'Vs budget', data: variance.map((v) => (v == null ? null : v * 100)), backgroundColor: scores.map(qaTone),
      borderColor: groups.map((g) => edge[groupNames.indexOf(g) % edge.length]), borderWidth: groupNames.length > 1 ? 2 : 0, yAxisID: 'y', order: 2, ...bar, borderSkipped: false },
    { type: 'line' as const, label: 'QA score', data: scores, showLine: false, pointStyle: 'rectRot', pointRadius: 6, pointHoverRadius: 7,
      pointBackgroundColor: t.bg, pointBorderColor: t.text, pointBorderWidth: 2, yAxisID: 'y2', order: 0 },
    { type: 'line' as const, label: `Pass ${pass}`, data: labels.map(() => pass), borderColor: t.ok, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, pointHitRadius: 0, yAxisID: 'y2', order: 1 },
    { type: 'line' as const, label: `Warn ${warn}`, data: labels.map(() => warn), borderColor: t.warn, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, pointHitRadius: 0, yAxisID: 'y2', order: 1 },
  ] } as unknown as ChartData<'bar'>
  const options = { ...o,
    scales: { x: { ...o.scales!.x, grid: { display: false }, ticks: { color: t.text2, autoSkip: false, maxRotation: 60, font: { size: 10 } } },
      y: { ...o.scales!.y, ticks: { color: t.text2, callback: (v: string | number) => `${v}%` }, title: { display: true, text: 'Vs budget', color: t.text3 } },
      y2: { position: 'right' as const, min: 60, max: 105, grid: { display: false }, border: { display: false }, ticks: { color: t.text2, stepSize: 10 }, title: { display: true, text: 'QA score', color: t.text3 } } },
    plugins: { ...o.plugins, tooltip: { ...o.plugins!.tooltip, filter: (c: { datasetIndex: number }) => c.datasetIndex < 2,
      callbacks: { label: (c: { datasetIndex: number; parsed: { y: number | null } }) => (c.datasetIndex === 0
        ? `Vs budget: ${c.parsed.y == null ? 'no budget' : `${c.parsed.y >= 0 ? '+' : ''}${c.parsed.y.toFixed(1)}%`}` : `QA score: ${c.parsed.y == null ? 'none' : c.parsed.y.toFixed(1)}`) } } } }
  return <Chart type="bar" data={data} options={options as unknown as ChartOptions<'bar'>} aria-label="QA score and labor against budget by site" role="img" />
}

/** Weekly invoice against core, pallet and sub labor by group (the FedEx report's "where the labor dollars went"). */
export function LaborMixChart({ labels, invoice, core, pallet, sub, subLabel, directLabel = 'Core labor', invoiceLabel = 'Weekly invoice' }: { labels: string[]; invoice: number[]; core: number[]; pallet: number[]; sub: number[]; subLabel: string; directLabel?: string; invoiceLabel?: string }) {
  const t = useTokens()
  const o = base(t)
  const data = { labels, datasets: [
    { label: invoiceLabel, data: invoice, backgroundColor: t.accent2, stack: 'i', ...bar, borderRadius: 0 },
    { label: directLabel, data: core, backgroundColor: t.accent, stack: 'l', ...bar, borderRadius: 0 },
    { label: 'Pallet labor', data: pallet, backgroundColor: t.warn, stack: 'l', ...bar, borderRadius: 0 },
    { label: subLabel, data: sub, backgroundColor: t.muted, stack: 'l', ...bar, borderRadius: 0 },
  ] }
  const options: ChartOptions<'bar'> = { ...o, indexAxis: 'y',
    scales: { x: { ...o.scales!.x, stacked: true, ticks: { color: t.text2, callback: (v) => `$${Number(v) / 1000}K` } }, y: { ...o.scales!.y, stacked: true, grid: { display: false } } },
    plugins: { ...o.plugins, tooltip: { ...o.plugins!.tooltip, callbacks: { label: (c) => `${c.dataset.label}: ${money(c.parsed.x)}` } } } }
  return <Bar data={data} options={options} aria-label="Weekly invoice against core, pallet and sub labor by group" role="img" />
}

/** Labor dollars by period as bars (muted before weekFrom, the current one highlighted), invoice and labor % as lines, target dashed. */
export function MonthWeekTrendChart({ labels, labor, invoice, lp, target, weekFrom, current, weekTargets, onPick, sitesLp, unit = 'week' }: { labels: string[]; labor: (number | null)[]; invoice: (number | null)[]; lp: (number | null)[]; target: number; weekFrom: number; current: number
  /** The period each point is: names the series in the tooltip. */
  unit?: 'week' | 'month'
  /** Each point's budget target (the weekly budget calendar): drawn as the green stepped line in place of the flat target. */
  weekTargets?: (number | null)[]
  /** Click a point to open it. */
  onPick?: (index: number) => void
  /** Sites-only labor % (without catch-all and non-billed jobs), drawn beside the account's. */
  sitesLp?: (number | null)[] }) {
  const t = useTokens()
  const o = base(t) as unknown as ChartOptions<'bar'>
  const data = { labels, datasets: [
    { type: 'bar' as const, label: unit === 'month' ? 'Labor, month' : 'Labor, week', data: labor, backgroundColor: labels.map((_, i) => (i === current ? t.accent : i >= weekFrom ? t.accent2 : t.muted)), yAxisID: 'y', order: 3, ...bar },
    { type: 'line' as const, label: unit === 'month' ? 'Invoice, month' : 'Invoice, week', data: invoice, borderColor: t.text2, borderDash: [4, 3], borderWidth: 1.5, pointRadius: 2, yAxisID: 'y', order: 2 },
    { type: 'line' as const, label: 'Labor %', data: lp.map((v) => (v == null ? null : v * 100)), borderColor: t.bad, backgroundColor: t.bad, borderWidth: 2, pointRadius: 3, yAxisID: 'y1', order: 1 },
    ...(sitesLp ? [{ type: 'line' as const, label: 'Sites-only labor %', data: sitesLp.map((v) => (v == null ? null : v * 100)), borderColor: t.warn, backgroundColor: t.warn, borderWidth: 2, pointRadius: 3, yAxisID: 'y1', order: 1 }] : []),
    weekTargets
      ? { type: 'line' as const, label: 'Weekly budget target', data: weekTargets.map((v) => (v == null ? null : v * 100)), borderColor: t.tgt, backgroundColor: t.tgt, borderWidth: 4,
        stepped: 'middle', pointRadius: 4, pointHoverRadius: 7, pointBackgroundColor: t.tgt, pointBorderColor: t.bg, pointBorderWidth: 1.5, yAxisID: 'y1', order: -1 }
      : { type: 'line' as const, label: 'Target', data: labels.map(() => target * 100), borderColor: t.ok, borderDash: [5, 4], borderWidth: 1, pointRadius: 0, yAxisID: 'y1', order: 0 },
  ] } as unknown as ChartData<'bar'>
  const options = { ...o, interaction: { mode: 'index', intersect: false },
    onClick: (_e: unknown, els: { index: number }[]) => { if (onPick && els.length) onPick(els[0].index) },
    onHover: (e: { native?: { target?: EventTarget | null } }, els: unknown[]) => { const el = e.native?.target as HTMLElement | null; if (el && onPick) el.style.cursor = els.length ? 'pointer' : 'default' },
    scales: { x: { ...o.scales!.x, grid: { display: false } }, y: { ...o.scales!.y, beginAtZero: true, ticks: { color: t.text2, callback: (v: number | string) => `$${Number(v) / 1000}K` } },
      y1: { position: 'right', beginAtZero: true, suggestedMax: 90, max: pctAxisMax([...lp, ...(sitesLp ?? []), ...(weekTargets ?? [])].map((v) => (v == null ? null : v * 100)), Math.max(target * 100, 100)), grid: { display: false }, ticks: { color: t.text2, callback: (v: number | string) => `${v}%` } } },
    plugins: { ...o.plugins, tooltip: { ...o.plugins!.tooltip, callbacks: { label: (c: { dataset: { label?: string; yAxisID?: string }; parsed: { y: number | null } }) =>
      c.dataset.yAxisID === 'y1' ? `${c.dataset.label}: ${c.parsed.y == null ? '–' : `${c.parsed.y.toFixed(1)}%`}` : `${c.dataset.label}: ${money(c.parsed.y)}` } } } } as unknown as ChartOptions<'bar'>
  return <Chart type="bar" data={data} options={options} aria-label={`Labor against invoice by ${unit}, with labor % and the target`} role="img" />
}

/** OT by week: OT hours as bars (the selected week highlighted) and OT % of hours as a line; click a week to open it. */
export function OtWeekChart({ labels, otHours, otPct, otDollars, current, onPick }: { labels: string[]; otHours: number[]; otPct: (number | null)[]; otDollars: number[]; current: number; onPick?: (index: number) => void }) {
  const t = useTokens()
  const o = base(t) as unknown as ChartOptions<'bar'>
  const data = { labels, datasets: [
    { type: 'bar' as const, label: 'OT hours', data: otHours, backgroundColor: labels.map((_, i) => (i === current ? t.warn : t.muted)), yAxisID: 'y', order: 2, ...bar },
    { type: 'line' as const, label: 'OT % of hours', data: otPct.map((v) => (v == null ? null : v * 100)), borderColor: t.bad, backgroundColor: t.bad, borderWidth: 2, pointRadius: 3, yAxisID: 'y1', order: 1 },
  ] } as unknown as ChartData<'bar'>
  const options = { ...o, interaction: { mode: 'index', intersect: false },
    onClick: (_e: unknown, els: { index: number }[]) => { if (onPick && els.length) onPick(els[0].index) },
    onHover: (e: { native?: { target?: EventTarget | null } }, els: unknown[]) => { const el = e.native?.target as HTMLElement | null; if (el && onPick) el.style.cursor = els.length ? 'pointer' : 'default' },
    scales: { x: { ...o.scales!.x, grid: { display: false } }, y: { ...o.scales!.y, beginAtZero: true, ticks: { color: t.text2, callback: (v: number | string) => fmtHours(Number(v)) } },
      y1: { position: 'right', beginAtZero: true, grid: { display: false }, ticks: { color: t.text2, callback: (v: number | string) => `${v}%` } } },
    plugins: { ...o.plugins, tooltip: { ...o.plugins!.tooltip, callbacks: { label: (c: { dataset: { yAxisID?: string }; dataIndex: number; parsed: { y: number | null } }) =>
      c.dataset.yAxisID === 'y1' ? `OT %: ${c.parsed.y == null ? '–' : `${c.parsed.y.toFixed(1)}%`}` : `OT hours: ${fmtHours(c.parsed.y ?? 0)} (${money(otDollars[c.dataIndex])})` } } } } as unknown as ChartOptions<'bar'>
  return <Chart type="bar" data={data} options={options} aria-label="Overtime hours and OT percent by week" role="img" />
}

/** Margin by site, worst first (AR − AP). */
export function MarginChart({ labels, values, tones, details }: { labels: string[]; values: number[]; tones: ('ok' | 'warn' | 'bad' | 'neutral')[]; details: string[] }) {
  const t = useTokens()
  const o = base(t)
  const data = { labels, datasets: [{ label: 'Margin', data: values, backgroundColor: tones.map((x) => tone(t, x)), ...bar, maxBarThickness: 14 }] }
  const options: ChartOptions<'bar'> = { ...o, indexAxis: 'y',
    scales: { x: { ...o.scales!.x, ticks: { color: t.text2, callback: (v) => `$${Number(v) / 1000}K` } }, y: { ...o.scales!.y, grid: { display: false }, ticks: { color: t.text2, autoSkip: false, font: { size: 10 } } } },
    plugins: { ...o.plugins, tooltip: { ...o.plugins!.tooltip, callbacks: { label: (c) => details[c.dataIndex] ?? money(c.parsed.x) } } } }
  return <Bar data={data} options={options} aria-label="Margin by site, worst first" role="img" />
}

/** Revenue by month (closed months solid, open months muted) with gross margin % on its own axis. */
export function RevenueMarginChart({ labels, revenue, marginPct, closed }: { labels: string[]; revenue: number[]; marginPct: (number | null)[]; closed: boolean[] }) {
  const t = useTokens()
  const o = base(t) as unknown as ChartOptions<'bar'>
  const data = { labels, datasets: [
    { type: 'bar' as const, label: 'Revenue', data: revenue, backgroundColor: closed.map((c) => (c ? t.accent : t.muted)), yAxisID: 'y', order: 2, ...bar },
    { type: 'line' as const, label: 'Gross margin %', data: marginPct.map((v) => (v == null ? null : v * 100)), borderColor: t.ok, backgroundColor: t.ok, borderWidth: 2, pointRadius: 3, yAxisID: 'y1', order: 1, spanGaps: false },
  ] } as unknown as ChartData<'bar'>
  const options = { ...o, interaction: { mode: 'index', intersect: false },
    scales: { x: { ...o.scales!.x, grid: { display: false } }, y: { ...o.scales!.y, beginAtZero: true, ticks: { color: t.text2, callback: (v: number | string) => `$${(Number(v) / 1e6).toFixed(1)}M` } },
      y1: { position: 'right', grid: { display: false }, ticks: { color: t.text2, callback: (v: number | string) => `${v}%` } } },
    plugins: { ...o.plugins, tooltip: { ...o.plugins!.tooltip, callbacks: { label: (c: { dataset: { label?: string; yAxisID?: string }; parsed: { y: number | null } }) =>
      c.dataset.yAxisID === 'y1' ? `${c.dataset.label}: ${c.parsed.y == null ? '–' : `${c.parsed.y.toFixed(1)}%`}` : `${c.dataset.label}: ${money(c.parsed.y)}` } } } } as unknown as ChartOptions<'bar'>
  return <Chart type="bar" data={data} options={options} aria-label="Revenue and gross margin by month" role="img" />
}

/** Stacked dollar bars by month, one series per group (business unit). */
export function StackedMoneyChart({ labels, series }: { labels: string[]; series: { label: string; data: number[]; color: string }[] }) {
  const t = useTokens()
  const o = base(t)
  const data = { labels, datasets: series.map((s) => ({ label: s.label, data: s.data, backgroundColor: s.color, stack: 'a', ...bar, borderRadius: 0 })) }
  const options: ChartOptions<'bar'> = { ...o, interaction: { mode: 'index', intersect: false },
    scales: { x: { ...o.scales!.x, stacked: true, grid: { display: false } }, y: { ...o.scales!.y, stacked: true, ticks: { color: t.text2, callback: (v) => `$${(Number(v) / 1e6).toFixed(1)}M` } } },
    plugins: { ...o.plugins, tooltip: { ...o.plugins!.tooltip, callbacks: { label: (c) => `${c.dataset.label}: ${money(c.parsed.y)}` } } } }
  return <Bar data={data} options={options} aria-label={`${series.map((s) => s.label).join(', ')} by month`} role="img" />
}

/** A categorical color per series index, from the theme tokens. */
export const seriesColor = (t: Tokens, i: number) => [t.accent, t.accent2, t.ok, t.warn, t.text3, t.bad][i % 6]

/** Several percentage series by week (one line per group) against a dashed target. Values above CAP are
 * drawn at the top edge so one bad week does not flatten the rest; the tooltip gives the real value. */
const CAP = 150
export function TrendLinesChart({ labels, series, target }: { labels: string[]; series: { label: string; color: string; data: (number | null)[] }[]; target: number }) {
  const t = useTokens()
  const o = base(t) as unknown as ChartOptions<'line'>
  const data = { labels, datasets: [
    ...series.map((s) => ({ label: s.label, data: s.data.map((v) => (v == null ? null : Math.min(CAP, v * 100))), borderColor: s.color, backgroundColor: s.color, borderWidth: 2, pointRadius: 2, pointHoverRadius: 4, spanGaps: false, tension: 0 })),
    { label: 'Target', data: labels.map(() => target * 100), borderColor: t.text, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, pointHitRadius: 0 },
  ] }
  const options: ChartOptions<'line'> = { ...o, interaction: { mode: 'index', intersect: false },
    scales: { x: { ...o.scales!.x, grid: { display: false } }, y: { ...o.scales!.y, beginAtZero: true, suggestedMax: 100, max: CAP, ticks: { color: t.text2, callback: (v) => `${v}%` } } },
    plugins: { ...o.plugins, tooltip: { ...o.plugins!.tooltip, callbacks: { label: (c) => {
      const raw = c.datasetIndex < series.length ? series[c.datasetIndex].data[c.dataIndex] : target
      return `${c.dataset.label}: ${raw == null ? '–' : `${(raw * 100).toFixed(1)}%`}`
    } } } } }
  return <Line data={data} options={options} aria-label={`Labor % by week for ${series.map((s) => s.label).join(', ')}`} role="img" />
}
