/**
 * Pure helpers for the AR aging "collectible only" toggle (finance reference source).
 * Customers flagged is_collectible=false (intercompany / settlement per the ar_treatment_rules
 * setting) are removed from the matrix and totals, and the buckets are re-summed from the
 * remaining customer rows so every number on the Billing view agrees.
 */
import type { AgingBucket, AgingCustomer, ArAgingResponse, ArCashApplication } from './apiTypes'

const sum = <T,>(rows: T[], pick: (row: T) => number | null | undefined) => rows.reduce((total, row) => total + (pick(row) ?? 0), 0)

export interface CollectibleView {
  customers: AgingCustomer[]
  excluded: AgingCustomer[]
  buckets: AgingBucket[]
  totalOpen: number
  /** Open invoice count; per-bucket counts are unknown once customers are filtered, so the buckets carry 0 there. */
  invoiceCount: number
}

/** True when the API reports a collectible total (i.e. the reference source with ar_treatment_rules applied). */
export const collectibleAvailable = (aging: ArAgingResponse | undefined | null): boolean => aging?.collectible_open !== undefined && aging?.collectible_open !== null

export function applyCollectible(aging: ArAgingResponse, collectibleOnly: boolean): CollectibleView {
  const excluded = aging.by_customer.filter((c) => c.is_collectible === false)
  if (!collectibleOnly) return { customers: aging.by_customer, excluded, buckets: aging.buckets, totalOpen: aging.total_open, invoiceCount: sum(aging.buckets, (b) => b.invoices) }
  const customers = aging.by_customer.filter((c) => c.is_collectible !== false)
  const buckets = aging.buckets.map((b) => ({ ...b, amount: sum(customers, (c) => c[b.bucket]), invoices: 0 }))
  return { customers, excluded, buckets, totalOpen: aging.collectible_open ?? sum(customers, (c) => c.total), invoiceCount: sum(customers, (c) => c.invoices) }
}

/** Below this share of open invoices with any payment applied, the aging is flagged as likely overstating collectible AR. */
export const CASH_APPLICATION_WARN_BELOW = 25
export const CASH_APPLICATION_WARNING = 'Aging likely overstates collectible AR if payments are not being applied in WinTeam.'
export const cashApplicationTone = (cash: ArCashApplication | null | undefined): 'ok' | 'warn' | null => {
  if (!cash) return null
  const pct = cash.pct_with_payment_applied
  return typeof pct === 'number' && !Number.isNaN(pct) && pct < CASH_APPLICATION_WARN_BELOW ? 'warn' : 'ok'
}
