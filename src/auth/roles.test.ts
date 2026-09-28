import { describe, expect, it } from 'vitest'
import { canOpenAdmin, demoAuthenticate, initials, isRole } from './roles'

describe('roles', () => {
  it('opens Administration to admins only', () => {
    expect(canOpenAdmin('admin')).toBe(true)
    expect(canOpenAdmin('analyst')).toBe(false)
    expect(canOpenAdmin('executive')).toBe(false)
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
