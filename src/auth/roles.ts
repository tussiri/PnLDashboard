import type { PageKey } from '../types'

export type Role = 'executive' | 'analyst' | 'admin'
export const ROLES: readonly Role[] = ['executive', 'analyst', 'admin']

export interface AuthUser { username: string; role: Role }

export const roleLabel: Record<Role, string> = { executive: 'Executive access', analyst: 'Analyst access', admin: 'Administrator access' }

export const isRole = (value: unknown): value is Role => typeof value === 'string' && (ROLES as readonly string[]).includes(value)

/** Every route the shell knows about, in navigation order. */
export const ALL_PAGES: readonly PageKey[] = ['overview', 'alerts', 'financial', 'revenue', 'expenses', 'profitability', 'billing', 'budget', 'forecast', 'labor', 'timekeeping', 'jobs', 'customers', 'geography', 'reports', 'data', 'admin']

/** Routes a role may open. Executives see only the Executive Overview; analysts everything except Administration. */
export function visibleRoutes(role: Role): ReadonlySet<PageKey> {
  if (role === 'executive') return new Set<PageKey>(['overview'])
  if (role === 'analyst') return new Set<PageKey>(ALL_PAGES.filter((page) => page !== 'admin'))
  return new Set<PageKey>(ALL_PAGES)
}

export const canAccess = (role: Role, page: PageKey): boolean => visibleRoutes(role).has(page)

/** Where a role lands after sign-in and where forbidden routes redirect. */
export const homeFor = (_role: Role): PageKey => 'overview'

/** Fixed development accounts (mirrors the API's dev mode). Password is dev-<username>. */
export const DEV_USERS: readonly AuthUser[] = ROLES.map((role) => ({ username: role, role }))
export const devPassword = (username: string) => `dev-${username}`

/** Demo sign-in used only when no API is reachable: the three development users, nothing else. */
export function demoAuthenticate(username: string, password: string): AuthUser | null {
  const user = DEV_USERS.find((u) => u.username === username.trim())
  return user && password === devPassword(user.username) ? user : null
}

export const initials = (username: string) => username.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join('') || '?'
