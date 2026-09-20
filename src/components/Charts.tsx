import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Line, Pie, PieChart, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts'
import type { AgingBucket, CostBreakdown, JobRow, PortfolioMonth } from '../services/apiTypes'
import { money, percent, moneyTick } from '../utils'
import { ChartTooltip, LegendToggles, gridProps, monthTick, series, useSeriesToggle, xAxisProps, yAxisProps } from './ChartKit'

const moneyFmt = (value: unknown, name: string): [string, string] => [money(Number(value ?? 0)), name]

/** Revenue vs budget bars with gross-profit line; legend toggles. */
export function PerformanceTrend({ data, showGrossProfit = true }: { data: PortfolioMonth[]; showGrossProfit?: boolean }) {
  const toggle = useSeriesToggle()
  const hasBudget = data.some((row) => row.budget_revenue !== null)
  const legend = [{ key: 'budget_revenue', name: 'Budget', color: series.primarySoft, kind: 'bar' as const }, { key: 'revenue', name: 'Revenue', color: series.primary }, ...(showGrossProfit ? [{ key: 'gross_profit', name: 'Gross profit', color: series.secondary }] : [])].filter((s) => hasBudget || s.key !== 'budget_revenue')
  return <div className="chart-with-legend"><LegendToggles series={legend} hidden={toggle.hidden} onToggle={toggle.toggle} /><ResponsiveContainer width="100%" height="100%"><ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
    <CartesianGrid {...gridProps} />
    <XAxis dataKey="month" tickFormatter={monthTick} {...xAxisProps} />
    <YAxis tickFormatter={moneyTick} {...yAxisProps} />
    <Tooltip content={<ChartTooltip formatter={moneyFmt} />} cursor={{ fill: 'var(--surface-2)' }} />
    {hasBudget && <Bar dataKey="budget_revenue" name="Budget" fill={series.primarySoft} radius={[4, 4, 0, 0]} hide={toggle.isHidden('budget_revenue')} isAnimationActive={false} />}
    <Line dataKey="revenue" name="Revenue" type="monotone" stroke={series.primary} strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} hide={toggle.isHidden('revenue')} isAnimationActive={false} />
    {showGrossProfit && <Line dataKey="gross_profit" name="Gross profit" type="monotone" stroke={series.secondary} strokeWidth={2} dot={false} hide={toggle.isHidden('gross_profit')} isAnimationActive={false} />}
  </ComposedChart></ResponsiveContainer></div>
}

/** Horizontal bars with direct value labels. */
export function GroupBars<T extends { name: string }>({ data, valueKey = 'revenue', format = (v: number) => money(v), color = series.primary, onSelect, max = 10 }: { data: T[]; valueKey?: string; format?: (v: number) => string; color?: string; onSelect?: (name: string) => void; max?: number }) {
  const rows = data.slice(0, max)
  return <ResponsiveContainer width="100%" height="100%"><BarChart data={rows} layout="vertical" margin={{ left: 4, right: 56, top: 4, bottom: 0 }} barCategoryGap={rows.length > 6 ? 4 : 8}>
    <CartesianGrid horizontal={false} stroke="var(--grid)" />
    <XAxis type="number" tickFormatter={(v) => format(v)} {...xAxisProps} />
    <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={118} tick={{ fill: 'var(--text)', fontSize: 11 }} />
    <Tooltip content={<ChartTooltip formatter={(v, n) => [format(Number(v ?? 0)), n]} />} cursor={{ fill: 'var(--surface-2)' }} />
    <Bar dataKey={valueKey} name={valueKey === 'revenue' ? 'Revenue' : valueKey} fill={color} radius={[0, 4, 4, 0]} isAnimationActive={false} onClick={onSelect ? (entry) => onSelect(String((entry as { name?: string }).name ?? '')) : undefined} cursor={onSelect ? 'pointer' : undefined}>
      <LabelList dataKey={valueKey} position="right" formatter={(value: unknown) => format(Number(value))} fill="var(--text)" fontSize={10} />
    </Bar>
  </BarChart></ResponsiveContainer>
}

/** Revenue vs gross-margin scatter; bubble size = hours; optional cross-highlight. */
export function MarginScatter({ jobs, onSelect, target = 25, highlight, onHover }: { jobs: JobRow[]; onSelect?: (job: JobRow) => void; target?: number | null; highlight?: string | null; onHover?: (job: JobRow | null) => void }) {
  // Margins are bounded to a readable window: sites with near-zero revenue and real costs produce
  // margins of -1000% or worse, which would flatten every other point. Out-of-window sites are
  // pinned to the edge (still clickable) and counted in the axis label.
  const MIN_Y = -100, MAX_Y = 100
  const raw = jobs.filter((j) => j.revenue > 0).map((j) => ({ x: j.revenue, y: j.gross_margin_pct ?? (j.gross_profit / j.revenue) * 100, z: Math.max(1, j.hours), job: j }))
  const clipped = raw.filter((d) => d.y < MIN_Y || d.y > MAX_Y).length
  const data = raw.map((d) => ({ ...d, y: Math.min(MAX_Y, Math.max(MIN_Y, d.y)) }))
  const ys = data.map((d) => d.y)
  const lo = Math.max(MIN_Y, Math.floor(Math.min(target ?? 25, ...ys) / 5) * 5 - 5), hi = Math.min(MAX_Y, Math.ceil(Math.max(target ?? 25, ...ys) / 5) * 5 + 5)
  const color = (job: JobRow) => (job.status === 'Critical' ? series.bad : job.status === 'Watch' ? series.warn : series.primary)
  return <ResponsiveContainer width="100%" height="100%"><ScatterChart margin={{ top: 10, right: 16, bottom: 4, left: 0 }}>
    <CartesianGrid stroke="var(--grid)" />
    <XAxis type="number" dataKey="x" name="Revenue" tickFormatter={moneyTick} {...xAxisProps} />
    <YAxis type="number" dataKey="y" name="Gross margin" unit="%" domain={[lo, hi]} {...yAxisProps} width={44} label={clipped ? { value: `${clipped} site${clipped === 1 ? '' : 's'} beyond ±100% pinned to edge`, position: 'insideBottomLeft', fill: 'var(--muted)', fontSize: 10 } : undefined} />
    <ZAxis type="number" dataKey="z" range={[40, 220]} name="Hours" />
    {target !== null && <ReferenceLine y={target} stroke="var(--amber)" strokeDasharray="4 4" label={{ value: `${target}% target`, position: 'insideTopRight', fill: 'var(--muted)', fontSize: 10 }} />}
    <Tooltip cursor={{ strokeDasharray: '4 4' }} content={<ChartTooltip labelFormatter={(_, payload) => (payload?.[0]?.payload as { job?: JobRow })?.job?.job_name ?? ''} formatter={(v, n) => [n === 'Revenue' ? money(Number(v)) : n === 'Hours' ? `${Math.round(Number(v)).toLocaleString()} h` : percent(Number(v)), n]} />} />
    <Scatter data={data} isAnimationActive={false} onClick={(point) => { const job = (point as { payload?: { job?: JobRow } }).payload?.job ?? (point as { job?: JobRow }).job; if (job && onSelect) onSelect(job) }} onMouseEnter={(point) => onHover?.((point as { payload?: { job?: JobRow } }).payload?.job ?? null)} onMouseLeave={() => onHover?.(null)} cursor={onSelect ? 'pointer' : undefined}>
      {data.map((d) => <Cell key={d.job.job_number} fill={color(d.job)} fillOpacity={highlight && highlight !== d.job.job_number ? 0.25 : 0.85} stroke={highlight === d.job.job_number ? 'var(--navy)' : 'none'} strokeWidth={2} />)}
    </Scatter>
  </ScatterChart></ResponsiveContainer>
}

export function AgingBars({ buckets, onSelect, active }: { buckets: AgingBucket[]; onSelect?: (bucket: AgingBucket['bucket'] | null) => void; active?: AgingBucket['bucket'] | null }) {
  const colors: Record<AgingBucket['bucket'], string> = { current: series.primary, d30: series.secondary, d60: series.warn, d90: series.bad, d90_plus: '#9b2c3a' }
  return <ResponsiveContainer width="100%" height="100%"><BarChart data={buckets} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}>
    <CartesianGrid {...gridProps} />
    <XAxis dataKey="label" {...xAxisProps} />
    <YAxis tickFormatter={moneyTick} {...yAxisProps} width={50} />
    <Tooltip content={<ChartTooltip formatter={(v, n) => [n === 'Invoices' ? String(v) : money(Number(v)), n]} labelFormatter={(l) => `${l} days`} />} cursor={{ fill: 'var(--surface-2)' }} />
    <Bar dataKey="amount" name="Open AR" radius={[5, 5, 0, 0]} isAnimationActive={false} onClick={onSelect ? (entry) => onSelect(((entry as { bucket?: AgingBucket['bucket'] }).bucket ?? null) === active ? null : (entry as { bucket?: AgingBucket['bucket'] }).bucket ?? null) : undefined} cursor={onSelect ? 'pointer' : undefined}>
      {buckets.map((b) => <Cell key={b.bucket} fill={colors[b.bucket]} fillOpacity={active && active !== b.bucket ? 0.35 : 1} />)}
      <LabelList dataKey="amount" position="top" formatter={(value: unknown) => money(Number(value))} fill="var(--text)" fontSize={10} />
    </Bar>
  </BarChart></ResponsiveContainer>
}

/** Donut-free cost mix: horizontal stacked list with visible values. */
export function CostMix({ parts }: { parts: { name: string; value: number; color: string; note?: string }[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0)
  return <div className="mix-list">
    <div className="mix-list__bar" aria-hidden="true">{parts.map((p) => <i key={p.name} style={{ width: `${total ? (p.value / total) * 100 : 0}%`, background: p.color }} />)}</div>
    {parts.map((p) => <div className="mix-list__row" key={p.name}><span style={{ background: p.color }} /><div><strong>{p.name}</strong>{p.note && <small>{p.note}</small>}</div><b className="num">{money(p.value)}</b><em className="num">{total ? percent((p.value / total) * 100, 0) : '—'}</em></div>)}
  </div>
}

// ---------------------------------------------------------- Direct-cost breakdown (finance reference source)

export type CostLineKey = 'labor_cost' | 'payroll_ti_cost' | 'subcontract_cost' | 'supplies_cost' | 'other_direct_cost'
/** One entry per direct-cost line, in P&L order, with a stable colour so every view reads the same. */
export const costLines: { key: CostLineKey; name: string; color: string }[] = [
  { key: 'labor_cost', name: 'Labor', color: series.navy },
  { key: 'payroll_ti_cost', name: 'Payroll taxes & insurance', color: series.primary },
  { key: 'subcontract_cost', name: 'Subcontractors', color: series.secondary },
  { key: 'supplies_cost', name: 'Supplies & materials', color: series.teal },
  { key: 'other_direct_cost', name: 'Other direct', color: series.warn },
]
export type CostRow = CostBreakdown & { labor_cost: number }
/** True when the payload carries the reference-source breakdown (direct_cost is a number). */
export const hasCostBreakdown = (row: Partial<CostRow> | null | undefined): row is CostRow => typeof row?.direct_cost === 'number'
export const costParts = (row: CostRow) => costLines.map((line) => ({ ...line, value: Number(row[line.key] ?? 0) }))

/** Donut of the direct-cost mix with the itemized list beside it. */
export function CostDonut({ row, centerLabel = 'direct cost' }: { row: CostRow; centerLabel?: string }) {
  const parts = costParts(row).filter((p) => p.value > 0)
  const total = parts.reduce((s, p) => s + p.value, 0)
  return <div className="donut-mix">
    <div className="donut-mix__chart">
      <ResponsiveContainer width="100%" height="100%"><PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
        <Pie data={parts} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="92%" paddingAngle={1.5} stroke="var(--surface)" strokeWidth={1.5} isAnimationActive={false}>{parts.map((p) => <Cell key={p.key} fill={p.color} />)}</Pie>
        <Tooltip content={<ChartTooltip formatter={(v, n) => [`${money(Number(v))} · ${percent(total ? (Number(v) / total) * 100 : null, 0)}`, n]} />} />
      </PieChart></ResponsiveContainer>
      <div className="donut-mix__center" aria-hidden="true"><strong className="num">{money(total)}</strong><span>{centerLabel}</span></div>
    </div>
    <div className="mix-list">{parts.map((p) => <div className="mix-list__row" key={p.key}><span style={{ background: p.color }} /><div><strong>{p.name}</strong></div><b className="num">{money(p.value)}</b><em className="num">{total ? percent((p.value / total) * 100, 0) : '—'}</em></div>)}</div>
  </div>
}

/** Stacked monthly bars of the direct-cost lines with legend toggles. */
export function CostStack({ data }: { data: (CostRow & { month: string })[] }) {
  const toggle = useSeriesToggle()
  const present = costLines.filter((line) => data.some((row) => Number(row[line.key] ?? 0) > 0))
  return <div className="chart-with-legend"><LegendToggles series={present.map((l) => ({ key: l.key, name: l.name, color: l.color, kind: 'bar' as const }))} hidden={toggle.hidden} onToggle={toggle.toggle} /><ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap={4}>
    <CartesianGrid {...gridProps} />
    <XAxis dataKey="month" tickFormatter={monthTick} {...xAxisProps} />
    <YAxis tickFormatter={moneyTick} {...yAxisProps} />
    <Tooltip content={<ChartTooltip formatter={moneyFmt} footer={(p) => { const row = p[0]?.payload as CostRow | undefined; return row ? <span>Direct cost {money(row.direct_cost)}</span> : null }} />} cursor={{ fill: 'var(--surface-2)' }} />
    {present.map((l, i) => <Bar key={l.key} dataKey={l.key} name={l.name} stackId="cost" fill={l.color} hide={toggle.isHidden(l.key)} radius={i === present.length - 1 ? [3, 3, 0, 0] : undefined} isAnimationActive={false} />)}
  </BarChart></ResponsiveContainer></div>
}
