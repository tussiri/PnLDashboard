import { request } from '../services/api'
import type { Permission } from './permissions'
import type { AuthUser, Role } from './roles'

export type AuthMode = 'dev' | 'required'

/** A sign-in user as Admin > Users lists it (never a password hash). */
export interface AppUser {
  username: string
  role: Role
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
export interface AppUserPatch { role?: Role; active?: boolean; password?: string; accounts?: string[]; permissions?: Partial<Record<Permission, boolean>> }

/** Session routes are same-origin and cookie-based; the browser never sees the session value. */
export const authApi = {
  mode: (signal?: AbortSignal) => request<{ mode: AuthMode }>('/auth/mode', { signal, timeoutMs: 8_000 }),
  me: (signal?: AbortSignal) => request<{ user: AuthUser }>('/auth/me', { signal, timeoutMs: 8_000 }),
  login: (username: string, password: string, signal?: AbortSignal) => request<{ user: AuthUser }>('/auth/login', { method: 'POST', body: { username, password }, signal, timeoutMs: 15_000 }),
  logout: (signal?: AbortSignal) => request<{ ok: boolean }>('/auth/logout', { method: 'POST', signal, timeoutMs: 8_000 }),
  /** Whether the one-time first-administrator page is open. */
  setupStatus: (signal?: AbortSignal) => request<{ needed: boolean }>('/auth/setup', { signal, timeoutMs: 8_000 }),
  setup: (token: string, username: string, password: string) => request<{ user: AuthUser }>('/auth/setup', { method: 'POST', body: { token, username, password }, timeoutMs: 15_000 }),
}

/** Admin > Users (administrator session required). */
export const usersApi = {
  list: (signal?: AbortSignal) => request<{ users: AppUser[] }>('/users', { signal, rawRatios: true }),
  create: (username: string, role: Role, password: string, accounts: string[] = []) => request<{ user: AppUser }>('/users', { method: 'POST', body: { username, role, password, accounts }, rawRatios: true }),
  update: (username: string, patch: AppUserPatch) => request<{ user: AppUser }>(`/users/${encodeURIComponent(username)}`, { method: 'PATCH', body: patch, rawRatios: true }),
}
