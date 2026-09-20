/**
 * Ratio trend cards shared by the BU Overview (per-BU small multiples, the total) and the site tabs (per-site
 * grid). One builder turns a scope's weekly sums into series + the weekly table; `RatioTrendCard` picks the
 * delivery-aware chart: `labor` (Labor % vs target with Cost % on the same 0-120 % axis) when the scope has
 * self-performed hours, `cost_margin` (Cost % on top, margin dollars below - two single-axis panels, never a
 * dual axis) when it is fully subcontracted.
 */
import type { ReactNode } from 'react'
import { ANOMALY_PCT, anomalyNote, csvFileName, dollarClampMax, fmtMetric, trendKind, wowText, type ExecMetric, type TableRow, type WeeklyTable } from './charts'
import { ChartCard, type LegendItem } from './ChartCard'
import { COST_COLOR, ExecChart, MARGIN_COLOR, type ExecSeries } from './ExecChart'
import { WeekIndex, costPctOf, laborPctOf, marginOf, marginPctOf, round1, type BuSum } from './model'
import { Est } from './pieces'

export interface WeeklySeries {
  weeks: string[]
  sums: (BuSum | null)[]
  laborPct: (number | null)[]
  costPct: (number | null)[]
  /** Subcontracted vendor cost as % of invoicing. */
  vendorPct: (number | null)[]
  /** Agency (temp labor on self-performed sites) as % of invoicing. */
  agencyPct: (number | null)[]
  margin: (number | null)[]
  marginPct: (number | null)[]
  invoicing: (number | null)[]
  labor: (number | null)[]
  vendor: (number | null)[]
  dollars: (number | null)[]
  /** OT premium (`ot_dollars`). */
  otDollars: (number | null)[]
  /** Full OT pay (`otPayOf`), what the OT charts plot as "OT cost". */
  otPay: (number | null)[]
  hours: (number | null)[]
  estimated: boolean[]
  anomalies: (string | null)[]
}

const pctOrNull = (num: number, den: number) => (den && num > 0 ? round1((num / den) * 100) : null)

/** Weekly series for a scope: `sumOf` returns the scope's BuSum for a week (null when it has no rows). */
export function weeklySeries(idx: WeekIndex, sumOf: (week: string) => BuSum | null): WeeklySeries {
  const weeks = idx.weeks
  const sums = weeks.map((w) => { const s = sumOf(w); return s && s.sites > 0 ? s : null })
  const costPct = sums.map((s) => { const p = s ? costPctOf(s) : null; return p === null ? null : round1(p) })
  return {
    weeks, sums, costPct,
    laborPct: sums.map((s) => (s && s.selfInvoicing ? round1(laborPctOf(s)) : null)),
    vendorPct: sums.map((s) => (s ? pctOrNull(s.vendor, s.invoicing) : null)),
    agencyPct: sums.map((s) => (s ? pctOrNull(s.agency, s.invoicing) : null)),
    margin: sums.map((s) => (s && s.invoicing ? Math.round(marginOf(s)) : null)),
    marginPct: sums.map((s) => { const p = s ? marginPctOf(s) : null; return p === null ? null : round1(p) }),
    invoicing: sums.map((s) => (s ? Math.round(s.invoicing) : null)),
    labor: sums.map((s) => (s ? Math.round(s.labor) : null)),
    vendor: sums.map((s) => (s ? Math.round(s.vendor) : null)),
    dollars: sums.map((s) => (s ? Math.round(s.dollars) : null)),
    otDollars: sums.map((s) => (s ? Math.round(s.otDollars) : null)),
    otPay: sums.map((s) => (s ? Math.round(s.otPay) : null)),
    hours: sums.map((s) => (s ? Math.round(s.hours) : null)),
    estimated: sums.map((s) => Boolean(s && (s.subEstimated || s.invoicingEstimated))),
    anomalies: weeks.map((w, i) => anomalyNote(w, costPct[i])),
  }
}

/** The value to headline: the selected week's when it has one, else the latest week with a value; with its predecessor. */
export function headlineValue(values: (number | null)[], weeks: string[], selected: string | null): { value: number | null; prev: number | null; week: string | null } {
  let i = selected ? weeks.indexOf(selected) : -1
  if (i < 0 || values[i] === null) { i = values.length - 1; while (i >= 0 && values[i] === null) i-- }
  if (i < 0) return { value: null, prev: null, week: null }
  let j = i - 1
  while (j >= 0 && values[j] === null) j--
  return { value: values[i], prev: j >= 0 ? values[j] : null, week: weeks[i] }
}

/** "62.3% · +1.2 pp WoW · ~est" headline for a compact card. */
export function Headline({ metric, values, weeks, selected, estimated, tone, suffix }: { metric: ExecMetric; values: (number | null)[]; weeks: string[]; selected: string | null; estimated?: boolean[]; tone?: string; suffix?: string }) {
  const h = headlineValue(values, weeks, selected)
  const wow = wowText(metric, h.value, h.prev)
  const est = h.week ? Boolean(estimated?.[weeks.indexOf(h.week)]) : false
  const up = h.value !== null && h.prev !== null && h.value > h.prev
  return <>
    <strong className={tone}>{fmtMetric(metric, h.value)}</strong>{suffix && h.value !== null && <span className="hl-suffix"> {suffix}</span>}
    {wow && <span className={`wow ${up ? 'up-bad' : 'dn-ok'}`}> · {wow}</span>}
    {est && <Est label="~est" />}
  </>
}

const flag = (s: WeeklySeries, i: number) => s.estimated[i]

function laborTable(s: WeeklySeries, partial: ReadonlySet<string>): WeeklyTable {
  return {
    columns: [
      { key: 'week', header: 'Week', kind: 'text' }, { key: 'labor_pct', header: 'Labor %', kind: 'pct' }, { key: 'cost_pct', header: 'Cost %', kind: 'pct' },
      { key: 'agency_pct', header: 'Agency %', kind: 'pct' }, { key: 'vendor_pct', header: 'Vendor %', kind: 'pct' }, { key: 'invoicing', header: 'Invoicing', kind: 'dollars' },
      { key: 'labor', header: 'Labor $', kind: 'dollars' }, { key: 'vendor', header: 'Vendor $', kind: 'dollars' }, { key: 'dollars', header: 'Total cost', kind: 'dollars' },
      { key: 'margin', header: 'Margin', kind: 'dollars' }, { key: 'hours', header: 'Hours', kind: 'number' }, { key: 'est', header: 'Basis', kind: 'flag' }, { key: 'note', header: 'Note', kind: 'text' },
    ],
    rows: s.weeks.map((week, i): TableRow => ({ week: `${week}${partial.has(week) ? ' (in progress)' : ''}`, labor_pct: s.laborPct[i], cost_pct: s.costPct[i], agency_pct: s.agencyPct[i], vendor_pct: s.vendorPct[i], invoicing: s.invoicing[i], labor: s.labor[i], vendor: s.vendor[i], dollars: s.dollars[i], margin: s.margin[i], hours: s.hours[i], est: flag(s, i), note: s.anomalies[i] ?? '' })),
  }
}

function costMarginTable(s: WeeklySeries, partial: ReadonlySet<string>): WeeklyTable {
  return {
    columns: [
      { key: 'week', header: 'Week', kind: 'text' }, { key: 'cost_pct', header: 'Cost %', kind: 'pct' }, { key: 'vendor', header: 'Vendor cost', kind: 'dollars' }, { key: 'invoicing', header: 'Invoicing', kind: 'dollars' },
      { key: 'margin', header: 'Margin', kind: 'dollars' }, { key: 'margin_pct', header: 'Margin %', kind: 'pct' }, { key: 'est', header: 'Basis', kind: 'flag' }, { key: 'note', header: 'Note', kind: 'text' },
    ],
    rows: s.weeks.map((week, i): TableRow => ({ week: `${week}${partial.has(week) ? ' (in progress)' : ''}`, cost_pct: s.costPct[i], vendor: s.vendor[i], invoicing: s.invoicing[i], margin: s.margin[i], margin_pct: s.marginPct[i], est: flag(s, i), note: s.anomalies[i] ?? '' })),
  }
}

export const anomalyFootnote = (s: WeeklySeries): ReactNode => (s.anomalies.some(Boolean) ? <>◯ marks weeks where cost exceeds {ANOMALY_PCT}% of invoicing (hover for the reason); values beyond the axis are drawn at its edge with a ▲ / ▼ and the real value in the tooltip.</> : null)

export interface RatioTrendCardProps {
  title: string
  titleColor?: string
  subtitle?: ReactNode
  /** Scope name for the CSV file. */
  csvKey?: string
  idx: WeekIndex
  week: string
  series: WeeklySeries
  /** `labor` / `cost_margin`; derived from the scope's rows when omitted. */
  kind?: 'labor' | 'cost_margin'
  color: string
  target?: { value: number; label: string }
  /** False under the Subcontracted filter: the labor line is hidden and Cost % becomes the primary series. */
  showLabor?: boolean
  compact?: boolean
  headlineTone?: string
  className?: string
}

export function RatioTrendCard({ title, titleColor, subtitle, csvKey, idx, week, series: s, kind, color, target, showLabor = true, compact, headlineTone, className }: RatioTrendCardProps) {
  const partial = idx.partialWeeks
  const k = kind ?? trendKind(s.sums.flatMap((x, i) => (x ? [{ hours: x.hours, delivery_model: x.selfSites > 0 ? null : 'subcontracted' as const, i }] : [])))
  const csvName = csvFileName(csvKey ?? title, week)
  if (k === 'cost_margin') {
    const legend: LegendItem[] = [{ label: 'Cost % of invoicing', color: COST_COLOR }, { label: 'Margin $', color: MARGIN_COLOR, kind: 'bar' }]
    const cost: ExecSeries = { id: 'cost', label: 'Cost %', values: s.costPct, color: COST_COLOR, primary: true }
    const margin: ExecSeries = { id: 'margin', label: 'Margin', values: s.margin, color: MARGIN_COLOR, kind: 'bar' }
    const extras = (i: number) => (s.marginPct[i] !== null ? [`Margin ${fmtMetric('pct', s.marginPct[i])} of invoicing · vendor ${fmtMetric('dollars', s.vendor[i])}`] : [])
    return <ChartCard title={title} titleColor={titleColor} subtitle={subtitle} legend={legend} compact={compact} height={compact ? 168 : undefined} className={className} table={costMarginTable(s, partial)} csvName={csvName} note={anomalyFootnote(s)}
      headline={compact ? <Headline metric="pct" values={s.costPct} weeks={s.weeks} selected={week} estimated={s.estimated} tone={headlineTone} suffix="cost of invoicing" /> : undefined}
      chart={(h) => {
        const gap = 6
        const top = Math.round((h - gap) * (compact ? 0.66 : 0.6))
        return <div className="panels">
          <ExecChart weeks={s.weeks} selectedWeek={week} partialWeeks={partial} estimated={s.estimated} metric="pct" series={[cost]} height={top} anomalies={s.anomalies} extras={extras} showXTicks={false} axisWidth={48} ariaLabel={`${title}: cost % of invoicing by week`} />
          <ExecChart weeks={s.weeks} selectedWeek={week} partialWeeks={partial} estimated={s.estimated} metric="dollars" dollarMax={dollarClampMax(s.margin)} series={[margin]} height={h - top - gap} axisWidth={48} ariaLabel={`${title}: margin dollars by week`} />
        </div>
      }} />
  }
  const laborHidden = !showLabor
  const legend: LegendItem[] = [
    ...(laborHidden ? [] : [{ label: 'Labor % of invoicing', color }]),
    { label: 'Cost % of invoicing (incl. vendor)', color: COST_COLOR },
    ...(target && !laborHidden ? [{ label: target.label, color: '#8a8a85', kind: 'dashed' as const }] : []),
  ]
  const chartSeries: ExecSeries[] = [
    { id: 'labor', label: 'Labor %', values: s.laborPct, color, primary: !laborHidden, hidden: laborHidden },
    { id: 'cost', label: 'Cost %', values: s.costPct, color: COST_COLOR, primary: laborHidden },
  ]
  const extras = (i: number) => {
    const lines: string[] = []
    if (s.agencyPct[i] !== null) lines.push(`Agency labor ${fmtMetric('pct', s.agencyPct[i])} of invoicing (in Labor %)`)
    if (s.vendorPct[i] !== null) lines.push(`Vendor cost ${fmtMetric('pct', s.vendorPct[i])} of invoicing (in Cost % only)`)
    if (s.margin[i] !== null) lines.push(`Margin ${fmtMetric('dollars', s.margin[i])} on ${fmtMetric('dollars', s.invoicing[i])} invoicing`)
    return lines
  }
  return <ChartCard title={title} titleColor={titleColor} subtitle={subtitle} legend={legend} compact={compact} className={className} table={laborTable(s, partial)} csvName={csvName} note={anomalyFootnote(s)}
    headline={compact ? <Headline metric="pct" values={laborHidden ? s.costPct : s.laborPct} weeks={s.weeks} selected={week} estimated={s.estimated} tone={headlineTone} suffix={laborHidden ? 'cost of invoicing' : `labor · target ≤${target?.value ?? '—'}%`} /> : undefined}
    chart={(h) => <ExecChart weeks={s.weeks} selectedWeek={week} partialWeeks={partial} estimated={s.estimated} metric="pct" series={chartSeries} target={laborHidden ? undefined : target} height={h} anomalies={s.anomalies} extras={extras} ariaLabel={`${title}: labor % and cost % of invoicing by week`} />} />
}
