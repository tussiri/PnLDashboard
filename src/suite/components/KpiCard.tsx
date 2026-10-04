import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { useId } from 'react'
import { Area, AreaChart, ResponsiveContainer } from 'recharts'
import { Skeleton } from './CardState'

interface KpiCardProps {
  label: string
  value: string
  /** Signed change vs the prior equivalent range. null = not available (rendered as "n/a"). */
  delta?: number | null
  /** How the delta is expressed: percent change or percentage points. */
  deltaUnit?: 'pct' | 'pts'
  deltaLabel?: string
  context?: string
  trend?: number[]
  favorable?: 'up' | 'down' | 'none'
  loading?: boolean
  onClick?: () => void
}

export function KpiCard({ label, value, delta = null, deltaUnit = 'pct', deltaLabel = 'vs prior', context, trend, favorable = 'up', loading = false, onClick }: KpiCardProps) {
  const gradientId = useId()
  if (loading) return <article className="kpi-card"><Skeleton variant="kpi" /></article>
  const hasDelta = delta !== null && delta !== undefined && !Number.isNaN(delta)
  const good = !hasDelta || delta === 0 || favorable === 'none' ? null : favorable === 'up' ? delta > 0 : delta < 0
  const Icon = !hasDelta || delta === 0 ? Minus : delta > 0 ? ArrowUpRight : ArrowDownRight
  const deltaText = hasDelta ? `${Math.abs(delta).toFixed(1)}${deltaUnit === 'pts' ? ' pts' : '%'}` : 'n/a'
  const Tag = onClick ? 'button' : 'article'
  return (
    <Tag className={`kpi-card ${onClick ? 'kpi-card--clickable' : ''}`} onClick={onClick} type={onClick ? 'button' : undefined}>
      <div className="kpi-card__top">
        <span>{label}</span>
        <span className={`delta ${good === null ? '' : good ? 'delta--good' : 'delta--bad'}`} title={hasDelta ? `${deltaLabel}` : 'No prior-range comparison available'}>
          <Icon size={13} aria-hidden="true" /> {deltaText}
        </span>
      </div>
      <strong className="num">{value}</strong>
      <div className="kpi-card__bottom">
        <span>{context ?? (hasDelta ? deltaLabel : '')}</span>
        {trend && trend.length > 1 && (
          <div className="sparkline" aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend.map((v, i) => ({ i, v }))} margin={{ top: 2, bottom: 0, left: 0, right: 0 }}>
                <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--blue)" stopOpacity={.24} /><stop offset="100%" stopColor="var(--blue)" stopOpacity={0} /></linearGradient></defs>
                <Area type="monotone" dataKey="v" stroke="var(--blue)" fill={`url(#${gradientId})`} strokeWidth={1.8} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </Tag>
  )
}
