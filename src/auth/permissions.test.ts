import { describe, expect, it } from 'vitest'
import { can, effective, overridesOf, PERMISSION_KEYS, ROLE_DEFAULTS } from './permissions'

describe('permissions', () => {
  it('role defaults: executives lack analytics and staffing, analysts lack analytics, admins hold all', () => {
    expect(ROLE_DEFAULTS.executive['view.analytics']).toBe(false)
    expect(ROLE_DEFAULTS.executive['data.staffing']).toBe(false)
    expect(ROLE_DEFAULTS.executive['tab.map']).toBe(true)
    expect(ROLE_DEFAULTS.analyst['data.staffing']).toBe(true)
    expect(PERMISSION_KEYS.every((k) => ROLE_DEFAULTS.admin[k])).toBe(true)
  })
  it('effective applies overrides except for administrators', () => {
    expect(effective('executive', { 'view.analytics': true, 'tab.map': false })).toMatchObject({ 'view.analytics': true, 'tab.map': false, 'tab.sites': true })
    expect(effective('admin', { 'view.company': false })['view.company']).toBe(true)
  })
  it('overridesOf keeps only the differences from the role', () => {
    expect(overridesOf('executive', ROLE_DEFAULTS.executive)).toEqual({})
    expect(overridesOf('analyst', { ...ROLE_DEFAULTS.analyst, 'view.analytics': true, 'data.export': false })).toEqual({ 'view.analytics': true, 'data.export': false })
  })
  it('can reads the API values, else the role default', () => {
    expect(can({ username: 'x', role: 'executive' }, 'data.staffing')).toBe(false)
    expect(can({ username: 'x', role: 'executive', permissions: { 'data.staffing': true } }, 'data.staffing')).toBe(true)
    expect(can({ username: 'x', role: 'admin', permissions: { 'view.company': false } }, 'view.company')).toBe(true)
  })
})

describe('view.company-story', () => {
  it('is off for every role but admin until an administrator grants it', () => {
    expect([ROLE_DEFAULTS.executive['view.company-story'], ROLE_DEFAULTS.analyst['view.company-story'], ROLE_DEFAULTS.admin['view.company-story']]).toEqual([false, false, true])
    expect(effective('executive', { 'view.company-story': true })['view.company-story']).toBe(true)
  })
})
