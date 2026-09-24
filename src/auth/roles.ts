export type Role = 'executive' | 'analyst' | 'admin'
export const ROLES: readonly Role[] = ['executive', 'analyst', 'admin']

export interface AuthUser { username: string; role: Role }

export const roleLabel: Record<Role, string> = { executive: 'Executive access', analyst: 'Analyst access', admin: 'Administrator access' }

export const isRole = (value: unknown): value is Role => typeof value === 'string' && (ROLES as readonly string[]).includes(value)

/** Leadership views a role may open: every role sees Home, Account and Analytics; only admins see Admin. */
export const canOpenAdmin = (role: Role): boolean => role === 'admin'

/** Fixed development accounts (mirrors the API's dev mode). Password is dev-<username>. */
export const DEV_USERS: readonly AuthUser[] = ROLES.map((role) => ({ username: role, role }))
export const devPassword = (username: string) => `dev-${username}`

/** Demo sign-in used only when no API is reachable: the three development users, nothing else. */
export function demoAuthenticate(username: string, password: string): AuthUser | null {
  const user = DEV_USERS.find((u) => u.username === username.trim())
  return user && password === devPassword(user.username) ? user : null
}

export const initials = (username: string) => username.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join('') || '?'
