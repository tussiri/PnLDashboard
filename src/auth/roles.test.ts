import { describe, expect, it } from 'vitest'
import { canOpenAdmin, demoAuthenticate, initials, isRole, isSuperAdmin } from './roles'

describe('roles', () => {
  it('opens Administration to admins only', () => {
    expect(canOpenAdmin('admin')).toBe(true)
    expect(canOpenAdmin('analyst')).toBe(false)
    expect(canOpenAdmin('executive')).toBe(false)
  })

  it('treats only administrators the API marks as super administrators', () => {
    expect(isSuperAdmin({ username: 'a', role: 'admin', super_admin: true })).toBe(true)
    expect(isSuperAdmin({ username: 'a', role: 'admin' })).toBe(false)
    expect(isSuperAdmin({ username: 'a', role: 'admin', super_admin: false })).toBe(false)
    expect(isSuperAdmin({ username: 'a', role: 'analyst', super_admin: true })).toBe(false)
    expect(isSuperAdmin(null)).toBe(false)
  })

  it('lets the demo administrator of a development build open the suite, and nobody else', () => {
    expect(isSuperAdmin({ username: 'admin', role: 'admin' }, { demo: true })).toBe(true)
    expect(isSuperAdmin({ username: 'analyst', role: 'analyst' }, { demo: true })).toBe(false)
  })

  it('validates roles', () => {
    expect(isRole('admin')).toBe(true)
    expect(isRole('superuser')).toBe(false)
    expect(isRole(null)).toBe(false)
  })
})

describe('demo sign-in', () => {
  it('accepts only the three development users with their dev passwords', () => {
    expect(demoAuthenticate('executive', 'dev-executive')).toEqual({ username: 'executive', role: 'executive' })
    expect(demoAuthenticate(' admin ', 'dev-admin')?.role).toBe('admin')
    expect(demoAuthenticate('admin', 'dev-analyst')).toBeNull()
    expect(demoAuthenticate('jane', 'dev-jane')).toBeNull()
  })

  it('builds avatar initials', () => {
    expect(initials('jane.doe')).toBe('JD')
    expect(initials('admin')).toBe('A')
  })
})
