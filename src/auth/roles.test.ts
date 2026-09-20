import { describe, expect, it } from 'vitest'
import { navItems } from '../components/AppShell'
import { ALL_PAGES, canAccess, demoAuthenticate, homeFor, initials, isRole, visibleRoutes } from './roles'

describe('role to visible routes', () => {
  it('executives see only the Executive Overview', () => {
    expect([...visibleRoutes('executive')]).toEqual(['overview'])
    expect(canAccess('executive', 'financial')).toBe(false)
    expect(canAccess('executive', 'admin')).toBe(false)
    expect(homeFor('executive')).toBe('overview')
  })

  it('analysts see every view except Administration', () => {
    const routes = visibleRoutes('analyst')
    expect(routes.has('admin')).toBe(false)
    expect(routes.size).toBe(ALL_PAGES.length - 1)
    expect(canAccess('analyst', 'reports')).toBe(true)
  })

  it('admins see everything', () => {
    expect(visibleRoutes('admin').size).toBe(ALL_PAGES.length)
    expect(canAccess('admin', 'admin')).toBe(true)
  })

  it('covers exactly the routes the navigation knows about', () => {
    expect(new Set(navItems.map((item) => item.key))).toEqual(new Set(ALL_PAGES))
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
