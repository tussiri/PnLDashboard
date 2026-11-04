import { describe, expect, it } from 'vitest'
import type { LeadershipAccount } from '../../services/apiTypes'
import { ACCOUNT_TABS } from '../routes'
import { tabLabel, tabsFor } from '../vocab'
import { lastMonthRange } from './FedexInvoices'

const has = { pallet: false, subcontracted: true, incomeStatement: false }

describe('FedEx invoices tab', () => {
  it('opens on last calendar month', () => {
    expect(lastMonthRange('2026-11-04')).toEqual(['2026-10-01', '2026-10-31'])
    expect(lastMonthRange('2026-01-15')).toEqual(['2025-12-01', '2025-12-31'])
    expect(lastMonthRange('2026-03-01')).toEqual(['2026-02-01', '2026-02-28'])
  })

  it('shows only on the FedEx report', () => {
    const fedex = { vocabulary: 'fedex' } as LeadershipAccount
    expect(tabsFor(fedex, ACCOUNT_TABS, has)).toContain('invoices')
    expect(tabsFor({ vocabulary: 'amazon' } as LeadershipAccount, ACCOUNT_TABS, has)).not.toContain('invoices')
    expect(tabLabel('invoices', fedex, 'Subcontractor')).toBe('FedEx invoices')
  })
})
