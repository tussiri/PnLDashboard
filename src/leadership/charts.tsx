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
    { label: 'Weekly invoice', data: invoice, backgroundColor: t.accent2, ...bar },
    { label: costLabel, data: cost, backgroundColor: t.accent, ...bar },
  ] }
  const options: ChartOptions<'bar'> = { ...o, indexAxis: 'y',
    scales: { x: { ...o.scales!.x, ticks: { color: t.text2, callback: (v) => `$${Number(v) / 1000}K` } }, y: { ...o.scales!.y, grid: { display: false } } },
    plugins: { ...o.plugins, tooltip: { ...o.plugins!.tooltip, callbacks: { label: (c) => `${c.dataset.label}: ${money(c.parsed.x)}` } } } }
  return <Bar data={data} options={options} aria-label={`Weekly invoice and ${costLabel.toLowerCase()} by segment`} role="img" />
}

/** Stacked horizontal bars of hours over target: OT premium share and extra hours. */
export function OverHoursChart({ labels, premium, extra }: { labels: string[]; premium: number[]; extra: number[] }) {
  const t = useTokens()
  const o = base(t)
  const data = { labels, datasets: [
    { label: 'OT premium hours', data: premium, backgroundColor: t.warn, ...bar, borderSkipped: false as const, borderRadius: 0 },
    { label: 'Extra hours', data: extra, backgroundColor: t.bad, ...bar, borderSkipped: 'start' as const },
  ] }
  const options: ChartOptions<'bar'> = { ...o, indexAxis: 'y',
    scales: { x: { ...o.scales!.x, stacked: true, title: { display: true, text: 'Base-rate equivalent hours', color: t.text3 } }, y: { ...o.scales!.y, stacked: true, grid: { display: false } } },
    plugins: { ...o.plugins, tooltip: { ...o.plugins!.tooltip, callbacks: { label: (c) => `${c.dataset.label}: ${Number(c.parsed.x).toFixed(1)}` } } } }
  return <Bar data={data} options={options} aria-label="Hours over target by site, split into OT premium and extra hours" role="img" />
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
