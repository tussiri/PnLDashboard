import { describe, expect, it } from 'vitest'
import type { LeadershipAccount } from '../services/apiTypes'
import { invoiceLabel, tabLabel, weekChange, wordsFor } from './vocab'

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
