/**
 * The words each weekly report uses, so an account's pages read like the report its leadership
 * already gets. 'amazon' (Amazon Labor P&L) is the default; 'fedex' follows the FedEx Labor P&L.
 */
import type { LeadershipAccount } from '../services/apiTypes'
import type { AccountTab } from './routes'
import type { Vocabulary } from './ui'

export const vocabOf = (account: LeadershipAccount | undefined): Vocabulary => account?.vocabulary ?? 'amazon'

const TABS: Record<Vocabulary, Record<AccountTab, string>> = {
  amazon: { overview: 'Overview', sites: 'Sites', pallet: 'Pallet', 'over-target': 'Hours to cut', overtime: 'Overtime', 'income-statement': 'Income Statement', subcontracted: 'Subcontracted Sites', map: 'Map', vendors: 'Vendors' },
  fedex: { overview: 'Account Overview', sites: 'Sites', pallet: 'Pallet', 'over-target': 'Over Target', overtime: 'Overtime', 'income-statement': 'Income Statement', subcontracted: 'Subcontracted Sites', map: 'Map', vendors: 'Sub invoices' },
}

export const tabLabel = (tab: AccountTab, account: LeadershipAccount | undefined, vendorLabel: string) =>
  tab === 'vendors' && vocabOf(account) === 'amazon' ? vendorLabel : TABS[vocabOf(account)][tab]

/** Tabs an account shows: the Pallet view only for accounts grouped by pallet, the Income Statement and
 * Subcontracted Sites views only for accounts that split their subcontracted sites out (FedEx). */
export function tabsFor(account: LeadershipAccount | undefined, all: readonly AccountTab[]): AccountTab[] {
  return all.filter((t) => (t !== 'pallet' || account?.group_by === 'pallet')
    && ((t !== 'income-statement' && t !== 'subcontracted') || Boolean(account?.split_subcontracted)))
}

/** Signed percentage points in the account's wording: "+0.7pp WoW" or "+0.7 pts vs prior wk". */
export function weekChange(change: number | null, vocab: Vocabulary): string {
  if (change == null || !Number.isFinite(change)) return '–'
  const n = `${change >= 0 ? '+' : '−'}${Math.abs(change * 100).toFixed(1)}`
  return vocab === 'fedex' ? `${n} pts vs prior wk` : `${n}pp WoW`
}
