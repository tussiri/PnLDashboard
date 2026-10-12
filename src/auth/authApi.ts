import { request } from '../services/api'
import type { Permission } from './permissions'
import type { AuthUser } from './roles'

export type AuthMode = 'dev' | 'required'
/** Microsoft sign-in on or off, and who may still use a password ('admins' once Microsoft sign-in is the norm). */
export interface SignInOptions { microsoft: boolean; password: 'all' | 'admins' }
/** Where the browser goes to sign in with Microsoft (a full-page navigation, not a fetch). */
export const MICROSOFT_SIGN_IN_PATH = '/api/v1/auth/entra/start'

/** A sign-in user as Admin > Users lists it (never a password hash). */
export interface AppUser {
  username: string
  /** A role's slug (Admin > Users > Roles); 'none' until an administrator picks one. */
  role: string
  role_name?: string
  active: boolean
  /** database: managed here; environment: APP_USERS_JSON (read-only); development: dev mode only. */
  source: 'database' | 'environment' | 'development'
  /** Account slugs the user may see; null = every account. */
  accounts: string[] | null
  /** Overrides over the role's defaults, and every permission after them. */
  permissions: Partial<Record<Permission, boolean>>
  effective_permissions: Record<Permission, boolean>
  created_at: string | null
  created_by: string | null
  last_login_at: string | null
}
export interface AppUserPatch { role?: string; active?: boolean; password?: string; accounts?: string[]; permissions?: Partial<Record<Permission, boolean>> }

/** Session routes are same-origin and cookie-based; the browser never sees the session value. */
export const authApi = {
  mode: (signal?: AbortSignal) => request<{ mode: AuthMode } & Partial<SignInOptions>>('/auth/mode', { signal, timeoutMs: 8_000 }),
  me: (signal?: AbortSignal) => request<{ user: AuthUser }>('/auth/me', { signal, timeoutMs: 8_000 }),
  login: (username: string, password: string, signal?: AbortSignal) => request<{ user: AuthUser }>('/auth/login', { method: 'POST', body: { username, password }, signal, timeoutMs: 15_000 }),
  /** The signed-in user's own password (any role); other sessions end, this one stays signed in. */
  changePassword: (currentPassword: string, newPassword: string) => request<{ user: AuthUser }>('/auth/password', { method: 'POST', body: { current_password: currentPassword, new_password: newPassword }, timeoutMs: 15_000 }),
  logout: (signal?: AbortSignal) => request<{ ok: boolean }>('/auth/logout', { method: 'POST', signal, timeoutMs: 8_000 }),
  /** Whether the one-time first-administrator page is open. */
  setupStatus: (signal?: AbortSignal) => request<{ needed: boolean }>('/auth/setup', { signal, timeoutMs: 8_000 }),
  setup: (token: string, username: string, password: string) => request<{ user: AuthUser }>('/auth/setup', { method: 'POST', body: { token, username, password }, timeoutMs: 15_000 }),
}

/** Admin > Users (administrator session required). */
export const usersApi = {
  list: (signal?: AbortSignal) => request<{ users: AppUser[] }>('/users', { signal, rawRatios: true }),
  create: (username: string, role: string, password: string, accounts: string[] = []) => request<{ user: AppUser }>('/users', { method: 'POST', body: { username, role, password, accounts }, rawRatios: true }),
  update: (username: string, patch: AppUserPatch) => request<{ user: AppUser }>(`/users/${encodeURIComponent(username)}`, { method: 'PATCH', body: patch, rawRatios: true }),
}

/** A role as Admin > Users > Roles lists it. Administrator and No access are fixed; Executive and Analyst
 * can be edited and reset but not deleted; a role somebody holds cannot be deleted. */
export interface AppRole {
  slug: string
  name: string
  permissions: Record<Permission, boolean>
  built_in: boolean
  editable: boolean
  deletable: boolean
  /** How many users hold it. */
  users: number
}

/** Admin > Users > Roles (administrator session required). */
export const rolesApi = {
  list: (signal?: AbortSignal) => request<{ roles: AppRole[] }>('/users/roles', { signal, rawRatios: true }),
  create: (name: string, copyFrom?: string) => request<{ role: AppRole }>('/users/roles', { method: 'POST', body: { name, copy_from: copyFrom || null }, rawRatios: true }),
  /** permissions: only the keys named change. */
  update: (slug: string, patch: { name?: string; permissions?: Partial<Record<Permission, boolean>> }) => request<{ role: AppRole }>(`/users/roles/${encodeURIComponent(slug)}`, { method: 'PATCH', body: patch, rawRatios: true }),
  reset: (slug: string) => request<{ role: AppRole }>(`/users/roles/${encodeURIComponent(slug)}/reset`, { method: 'POST', rawRatios: true }),
  remove: (slug: string) => request<{ ok: boolean }>(`/users/roles/${encodeURIComponent(slug)}`, { method: 'DELETE', rawRatios: true }),
}
