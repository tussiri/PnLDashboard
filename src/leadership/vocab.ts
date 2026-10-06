/**
 * The words each weekly report uses, so an account's pages read like the report its leadership
 * already gets. 'amazon' (Amazon Labor P&L) is the default; 'fedex' follows the FedEx Labor P&L.
 */
import type { LeadershipAccount } from '../services/apiTypes'
import type { AccountTab } from './routes'
import type { Vocabulary } from './ui'

export const vocabOf = (account: LeadershipAccount | undefined): Vocabulary => account?.vocabulary ?? 'amazon'

const TABS: Record<Vocabulary, Record<AccountTab, string>> = {
  amazon: { overview: 'Overview', sites: 'Sites', pallet: 'Pallet', 'over-target': 'Hours to cut', overtime: 'Overtime', 'income-statement': 'Income Statement', subcontracted: 'Subcontracted Sites', map: 'Map', vendors: 'Vendors', feedback: 'Feedback', budget: 'Budget' },
  fedex: { overview: 'Account Overview', sites: 'Sites', pallet: 'Pallet', 'over-target': 'Over Target', overtime: 'Overtime', 'income-statement': 'Income Statement', subcontracted: 'Subcontracted Sites', map: 'Map', vendors: 'Sub invoices', feedback: 'Feedback', budget: 'Budget' },
}

export const tabLabel = (tab: AccountTab, account: LeadershipAccount | undefined, vendorLabel: string) =>
  tab === 'vendors' && vocabOf(account) === 'amazon' ? vendorLabel : TABS[vocabOf(account)][tab]

/** Tabs an account shows, the same rule for every account: Pallet where it has pallet jobs, Subcontracted
 * Sites where it has subcontracted sites, Income Statement where one is loaded (or subcontracted sites
 * are split out, so the import has a home). */
export function tabsFor(_account: LeadershipAccount | undefined, all: readonly AccountTab[], has: { pallet: boolean; subcontracted: boolean; incomeStatement: boolean; feedback?: boolean; budget?: boolean }): AccountTab[] {
  return all.filter((t) => (t !== 'pallet' || has.pallet) && (t !== 'subcontracted' || has.subcontracted) && (t !== 'income-statement' || has.incomeStatement) && (t !== 'feedback' || Boolean(has.feedback)) && (t !== 'budget' || Boolean(has.budget)))
}

/** Signed percentage points in the account's wording: "+0.7pp WoW" or "+0.7 pts vs prior wk" (MoM /
 * "vs prior month" in the month-end rollup). */
export function weekChange(change: number | null, vocab: Vocabulary, period: 'week' | 'month' = 'week'): string {
  if (change == null || !Number.isFinite(change)) return '–'
  const n = `${change >= 0 ? '+' : '−'}${Math.abs(change * 100).toFixed(1)}`
  if (period === 'month') return vocab === 'fedex' ? `${n} pts vs prior month` : `${n}pp MoM`
  return vocab === 'fedex' ? `${n} pts vs prior wk` : `${n}pp WoW`
}

/** The invoice label for the period: FedEx's "Weekly invoice" reads "Monthly invoice" in the rollup. */
export const invoiceLabel = (words: Words, vocab: Vocabulary, period: 'week' | 'month' = 'week') =>
  period === 'month' && vocab === 'fedex' ? 'Monthly invoice' : words.invoice

const SOURCE: Record<string, string> = { job_cost: 'Job cost', relay_ar: 'Relay AR', contract: 'Contract', prior_month: 'Prior month' }
/** Where a month's billing came from, by site count: "Relay AR 301, contract 27". */
export function billingSources(rows: { revenue_month_basis: string | null; role: string }[]): string {
  const counts = new Map<string, number>()
  for (const r of rows) if (r.role === 'site' && r.revenue_month_basis) counts.set(r.revenue_month_basis, (counts.get(r.revenue_month_basis) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1]).map(([k, n], i) => `${i ? (SOURCE[k] ?? k).toLowerCase() : SOURCE[k] ?? k} ${n}`).join(', ')
}

/** The labels the shared views print, per report. Views are identical for every account; only these differ. */
export interface Words {
  invoice: string
  invoiceCol: string
  labor: string
  laborCol: string
  direct: string
  directCol: string
  accountLaborPct: string
  hours: string
  hoursOver: string
  hoursOverCol: string
  /** "{n} of {m} billed sites over" vs "{n} of {m} over". */
  over: (n: number, of: number) => string
  /** Prior closed month's labor %: "Jul LP" / "Jul actual". */
  prior: (month: string) => string
  trendTitle: string
  /** The vendor column: "Sub ~$" in the FedEx report, the account's own label otherwise. */
  subCol: (vendorLabel: string) => string
}

const WORDS: Record<Vocabulary, Words> = {
  amazon: {
    invoice: 'Invoicing', invoiceCol: 'Invoicing', labor: 'Total labor', laborCol: 'Total labor', direct: 'Direct', directCol: 'Direct labor',
    accountLaborPct: 'Labor %', hours: 'Hours', hoursOver: 'Hours to cut', hoursOverCol: 'Hrs to cut',
    over: (n, of) => `${n} of ${of} over`, prior: (m) => `${m} actual`,
    trendTitle: 'Total labor vs invoicing',
    subCol: (label) => label,
  },
  fedex: {
    invoice: 'Weekly invoice', invoiceCol: 'Invoice', labor: 'Labor', laborCol: 'Labor $', direct: 'Core', directCol: 'Core $',
    accountLaborPct: 'Account labor %', hours: 'Hours paid', hoursOver: 'Hours over target', hoursOverCol: 'Hrs over',
    over: (n, of) => `${n} of ${of} billed sites over`, prior: (m) => `${m} LP`,
    trendTitle: 'Labor vs invoice',
    subCol: () => 'Sub ~$',
  },
}

export const wordsFor = (vocab: Vocabulary): Words => WORDS[vocab]
