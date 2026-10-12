/** The built-in roles: the development and demo users hold these. Users from the API may hold any role
 * defined in Admin > Users > Roles (a slug), including No access. */
export type Role = 'executive' | 'analyst' | 'admin'
export const ROLES: readonly Role[] = ['executive', 'analyst', 'admin']
/** The role of a first Microsoft sign-in until an administrator picks one: nothing opens. */
export const NO_ACCESS = 'none'

/** role: the role's slug; role_name: its display name (from the API). accounts: the account slugs the user
 * may see; null or absent = every account. permissions: the effective per-user permissions from the API
 * (src/auth/permissions.ts); absent = the built-in role's defaults. */
export interface AuthUser { username: string; role: string; role_name?: string; accounts?: string[] | null; permissions?: Partial<Record<string, boolean>> | null }

export const roleLabel: Record<Role, string> = { executive: 'Executive access', analyst: 'Analyst access', admin: 'Administrator access' }

export const isRole = (value: unknown): value is Role => typeof value === 'string' && (ROLES as readonly string[]).includes(value)

/** Leadership views a role may open: every role sees Home and Account; only admins see Analytics (being reworked) and Admin. */
export const canOpenAdmin = (role: string): boolean => role === 'admin'

/** Fixed development accounts (mirrors the API's dev mode). Password is dev-<username>. */
export const DEV_USERS: readonly AuthUser[] = ROLES.map((role) => ({ username: role, role }))
export const devPassword = (username: string) => `dev-${username}`

/** Demo sign-in used only when no API is reachable: the three development users, nothing else. */
export function demoAuthenticate(username: string, password: string): AuthUser | null {
  const user = DEV_USERS.find((u) => u.username === username.trim())
  return user && password === devPassword(user.username) ? user : null
}

export const initials = (username: string) => username.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join('') || '?'
