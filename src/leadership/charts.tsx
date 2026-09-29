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

export interface Tokens { text: string; text2: string; text3: string; border: string; ok: string; warn: string; bad: string; accent: string; accent2: string; muted: string; bg: string }

function readTokens(): Tokens {
  const css = getComputedStyle(document.documentElement)
  const v = (n: string) => css.getPropertyValue(n).trim()
  return { text: v('--text'), text2: v('--text2'), text3: v('--text3'), border: v('--border'), ok: v('--ok'), warn: v('--warn'), bad: v('--bad'), accent: v('--accent'), accent2: v('--accent2'), muted: v('--muted'), bg: v('--bg') }
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

const bar = { borderRadius: 4, borderSkipped: 'start' as const, maxBarThickness: 24, categoryPercentage: 0.7, barPercentage: 0.9 }

/** Measure % by segment: this week (colored by status) against the prior month, with the target line. */
export function SegmentMeasureChart({ labels, week, weekTones, prior, target, weekLabel, priorLabel }: {
  labels: string[]; week: (number | null)[]; weekTones: ('ok' | 'warn' | 'bad' | 'neutral')[]; prior: (number | null)[]; target: number; weekLabel: string; priorLabel: string
}) {
  const t = useTokens()
  const o = base(t)
  const data = {
    labels,
    datasets: [
      { type: 'bar' as const, label: weekLabel, data: week.map((v) => (v == null ? null : v * 100)), backgroundColor: weekTones.map((tone) => statusColor(t, tone)), ...bar },
      { type: 'bar' as const, label: priorLabel, data: prior.map((v) => (v == null ? null : v * 100)), backgroundColor: t.muted, ...bar },
      { type: 'line' as const, label: 'Target', data: labels.map(() => target * 100), borderColor: t.text, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, pointHitRadius: 0 },
    ],
  }
  const options = { ...o, scales: { ...o.scales, y: { ...o.scales!.y, beginAtZero: true, ticks: { color: t.text2, callback: (v: string | number) => `${v}%` } }, x: { ...o.scales!.x, grid: { display: false } } },
    plugins: { ...o.plugins, tooltip: { ...o.plugins!.tooltip, callbacks: { label: (c: { dataset: { label?: string }; parsed: { y: number | null } }) => `${c.dataset.label}: ${c.parsed.y == null ? 'no billing' : `${c.parsed.y.toFixed(1)}%`}` } } } }
  return <Chart type="bar" data={data as unknown as ChartData<'bar', (number | null)[], string>} options={options as ChartOptions<'bar'>} aria-label={`${weekLabel} and ${priorLabel} by segment against a ${pct(target)} target`} role="img" />
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
export function TrendChart({ labels, values, target, label }: { labels: string[]; values: (number | null)[]; target: number; label: string }) {
  const t = useTokens()
  const o = base(t) as unknown as ChartOptions<'line'>
  const data = { labels, datasets: [
    { label, data: values.map((v) => (v == null ? null : v * 100)), borderColor: t.accent, backgroundColor: t.accent, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5, pointBorderColor: t.bg, pointBorderWidth: 2, spanGaps: false, tension: 0 },
    { label: 'Target', data: labels.map(() => target * 100), borderColor: t.text, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, pointHitRadius: 0 },
  ] }
  const options: ChartOptions<'line'> = { ...o,
    interaction: { mode: 'index', intersect: false },
    scales: { x: { ...o.scales!.x, grid: { display: false } }, y: { ...o.scales!.y, beginAtZero: true, ticks: { color: t.text2, callback: (v) => `${v}%` } } },
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

/** Closed months (weekly equivalent) then weeks: labor dollars as bars, invoice and labor % as lines, target dashed. */
export function MonthWeekTrendChart({ labels, labor, invoice, lp, target, weekFrom, current }: { labels: string[]; labor: (number | null)[]; invoice: (number | null)[]; lp: (number | null)[]; target: number; weekFrom: number; current: number }) {
  const t = useTokens()
  const o = base(t) as unknown as ChartOptions<'bar'>
  const data = { labels, datasets: [
    { type: 'bar' as const, label: 'Labor (weekly equiv.)', data: labor, backgroundColor: labels.map((_, i) => (i === current ? t.accent : i >= weekFrom ? t.accent2 : t.muted)), yAxisID: 'y', order: 3, ...bar },
    { type: 'line' as const, label: 'Invoice (weekly equiv.)', data: invoice, borderColor: t.text2, borderDash: [4, 3], borderWidth: 1.5, pointRadius: 2, yAxisID: 'y', order: 2 },
    { type: 'line' as const, label: 'Labor %', data: lp.map((v) => (v == null ? null : v * 100)), borderColor: t.bad, backgroundColor: t.bad, borderWidth: 2, pointRadius: 3, yAxisID: 'y1', order: 1 },
    { type: 'line' as const, label: 'Target', data: labels.map(() => target * 100), borderColor: t.ok, borderDash: [5, 4], borderWidth: 1, pointRadius: 0, yAxisID: 'y1', order: 0 },
  ] } as unknown as ChartData<'bar'>
  const options = { ...o, interaction: { mode: 'index', intersect: false },
    scales: { x: { ...o.scales!.x, grid: { display: false } }, y: { ...o.scales!.y, beginAtZero: true, ticks: { color: t.text2, callback: (v: number | string) => `$${Number(v) / 1000}K` } },
      y1: { position: 'right', beginAtZero: true, suggestedMax: 90, grid: { display: false }, ticks: { color: t.text2, callback: (v: number | string) => `${v}%` } } },
    plugins: { ...o.plugins, tooltip: { ...o.plugins!.tooltip, callbacks: { label: (c: { dataset: { label?: string; yAxisID?: string }; parsed: { y: number | null } }) =>
      c.dataset.yAxisID === 'y1' ? `${c.dataset.label}: ${c.parsed.y == null ? '–' : `${c.parsed.y.toFixed(1)}%`}` : `${c.dataset.label}: ${money(c.parsed.y)}` } } } } as unknown as ChartOptions<'bar'>
  return <Chart type="bar" data={data} options={options} aria-label="Labor against invoice by closed month and by week, with labor % and the target" role="img" />
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
