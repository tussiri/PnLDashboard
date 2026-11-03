import { describe, expect, it } from 'vitest'
import type { LeadershipAccount } from '../services/apiTypes'
import { ACCOUNT_TABS } from './routes'
import { invoiceLabel, tabLabel, tabsFor, weekChange, wordsFor } from './vocab'

const school = { vocabulary: 'school' } as LeadershipAccount

describe('school district wording', () => {
  it("names the tabs and cards as the district report does", () => {
    expect(tabLabel('overview', school, 'Vendor')).toBe('District Overview')
    expect(tabLabel('sites', school, 'Vendor')).toBe('Campuses')
    expect(tabLabel('over-target', school, 'Vendor')).toBe('Over Target')
    const w = wordsFor('school')
    expect([w.invoice, w.labor, w.accountLaborPct, w.hours, w.hoursOver]).toEqual(['Weekly invoice', 'Contract labor', 'Contract labor %', 'Hours worked', 'Hours over target'])
  })
  it('writes changes against the prior week and the monthly invoice in the rollup', () => {
    expect(weekChange(0.592, 'school')).toBe('+59.2 pts vs prior wk')
    expect(invoiceLabel(wordsFor('school'), 'school', 'month')).toBe('Monthly invoice')
  })
})

describe('the BU report', () => {
  const amazon = { vocabulary: 'amazon', segment_label: 'BU' } as LeadershipAccount
  const other = { vocabulary: 'amazon', segment_label: 'Group' } as LeadershipAccount
  const has = { pallet: false, subcontracted: false, incomeStatement: false }

  it('labels and adds its tabs only for an account grouped by business unit', () => {
    expect(tabLabel('overview', amazon, 'Agency sub')).toBe('BU Overview')
    expect(tabLabel('overview', other, 'Vendor')).toBe('Overview')
    expect(tabLabel('overtime', other, 'Vendor')).toBe('Overtime')
    expect(tabsFor(amazon, ACCOUNT_TABS, has)).toContain('over-budget')
    expect(tabsFor(other, ACCOUNT_TABS, has)).not.toContain('over-budget')
    expect(tabsFor(amazon, ACCOUNT_TABS, { ...has, month: true })).not.toContain('over-budget')
  })

  it('never lists the per-unit tab on its own', () => {
    expect(tabsFor(amazon, ACCOUNT_TABS, has)).not.toContain('bu')
  })
})
