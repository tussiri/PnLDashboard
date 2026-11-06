import { describe, expect, it } from 'vitest'
import { tabsFor } from '../vocab'
import { ACCOUNT_TABS } from '../routes'
import { zipOf } from './Directory'

describe('Directory tab', () => {
  it('shows for every account', () => {
    expect(tabsFor(undefined, ACCOUNT_TABS, { pallet: false, subcontracted: false, incomeStatement: false, feedback: false, budget: false })).toContain('directory')
  })
  it('formats nine-digit ZIPs and leaves the rest', () => {
    expect(zipOf('928215719')).toBe('92821-5719')
    expect(zipOf('93304')).toBe('93304')
    expect(zipOf('H7T 1A1')).toBe('H7T 1A1')
    expect(zipOf(null)).toBeNull()
  })
})
