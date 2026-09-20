import { ACCOUNT_ROW, PORTFOLIO_ROW, SCOPE_ROW, type DeliveryModel, type ForecastAccuracy, type ForecastMetric, type ForecastRow } from '../services/apiTypes'
import { percent } from '../utils'

/** An engine aggregate lead row. Its job_number is a sentinel, never a site code, so it is not
 *  rendered as one. */
export const isAggregateRow = (jobNumber: string) =>
  jobNumber === PORTFOLIO_ROW || jobNumber === ACCOUNT_ROW || jobNumber === SCOPE_ROW

/**
 * The rows behind the headline cards. With an account selected only the `__ACCOUNT__` aggregate
 * qualifies; the whole-portfolio `__ALL__` row is never shown under an account (an older server
 * that still returns it yields no headline rather than a misleading one). Sorted by horizon step.
 */
export function headlineRow(rows: ForecastRow[] | undefined | null, account: string | null | undefined): ForecastRow[] {
  const wanted = account ? ACCOUNT_ROW : PORTFOLIO_ROW
  return (rows ?? []).filter((r) => r.job_number === wanted).sort((a, b) => a.horizon_step - b.horizon_step)
}

/** Below this share of last-closed revenue the account aggregate is called out as understating the account. */
export const COVERAGE_CAVEAT_THRESHOLD = 80
export const COVERAGE_CAVEAT = 'Sites gated out for short history are not in this total; the account aggregate understates the account by roughly the uncovered share.'
export const coverageCaveat = (pct: number | null | undefined): string | null => (typeof pct === 'number' && !Number.isNaN(pct) && pct < COVERAGE_CAVEAT_THRESHOLD ? COVERAGE_CAVEAT : null)

export const deliveryLabel = (model: DeliveryModel | null | undefined) => (model === 'subcontracted' ? 'Subcontracted' : model === 'self_perform' ? 'Self-performed' : '—')

const volatilityTone = (value: string | null | undefined) => (!value ? 'none' : /low|stable/i.test(value) ? 'low' : /medium|moderate/i.test(value) ? 'medium' : /high|volatile/i.test(value) ? 'high' : 'none')

export function VolatilityChip({ value }: { value: string | null | undefined }) {
  return <span className={`vol-chip vol-chip--${volatilityTone(value)}`}>{value ?? '—'}</span>
}

/**
 * Run metadata coverage is engine-defined. The live engine records it per metric and horizon
 * ({metric: {"1": {n, coverage}}}); older shapes may carry measured_80 / target. Both are summarized.
 */
export function coverageSummary(coverage: Record<string, unknown> | undefined, metric: ForecastMetric): { text: string; overall: number | null } {
  if (!coverage) return { text: 'not recorded', overall: null }
  const perMetric = coverage[metric]
  if (perMetric && typeof perMetric === 'object' && !Array.isArray(perMetric)) {
    const entries = Object.entries(perMetric as Record<string, { n?: number; coverage?: number }>).filter(([, v]) => v && typeof v === 'object').sort(([a], [b]) => Number(a) - Number(b))
    let n = 0, hits = 0
    const parts = entries.map(([h, v]) => { const count = Number(v.n ?? 0); if (typeof v.coverage === 'number') { n += count; hits += v.coverage * count } return `h${h} ${typeof v.coverage === 'number' ? percent(v.coverage * 100, 1) : '—'} (n=${count.toLocaleString()})` })
    return { text: parts.join(' · ') || 'not recorded', overall: n ? (hits / n) * 100 : null }
  }
  const measured = (coverage.measured_80 ?? coverage.measured) as number | undefined
  if (typeof measured === 'number') return { text: `${percent(measured * 100, 0)} measured${typeof coverage.n_evaluated === 'number' ? ` (n=${coverage.n_evaluated})` : ''}`, overall: measured * 100 }
  return { text: 'not recorded', overall: null }
}

export const metricLabel: Record<ForecastMetric, string> = { revenue: 'Revenue', gross_profit: 'Gross profit', labor_cost: 'Labor cost', subcontract_cost: 'Subcontract cost' }

/** Accuracy is only claimed when the engine has at least 3 backtests behind it. */
export function AccuracyBadge({ accuracy }: { accuracy: ForecastAccuracy | null | undefined }) {
  if (!accuracy || accuracy.n_backtests < 3) return <span className="accuracy-badge accuracy-badge--none" title={accuracy ? `${accuracy.n_backtests} backtests — too few to report accuracy` : 'No backtests'}>Unmeasured</span>
  const ape = accuracy.median_ape ?? null
  const tone = ape === null ? 'none' : ape <= 5 ? 'good' : ape <= 10 ? 'ok' : 'weak'
  return <span className={`accuracy-badge accuracy-badge--${tone}`} title={`${accuracy.n_backtests} backtests · median APE ${percent(ape)} · MASE ${accuracy.mase ?? '—'} · coverage ${accuracy.coverage === null ? '—' : percent(accuracy.coverage * 100, 0)}`}>{ape === null ? 'n/a' : `±${percent(ape, 1)}`}<small>n={accuracy.n_backtests}</small></span>
}
