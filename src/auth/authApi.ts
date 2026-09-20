import { request } from '../services/api'
import type { AuthUser } from './roles'

export type AuthMode = 'dev' | 'required'

/** Session routes are same-origin and cookie-based; the browser never sees the session value. */
export const authApi = {
  mode: (signal?: AbortSignal) => request<{ mode: AuthMode }>('/auth/mode', { signal, timeoutMs: 8_000 }),
  me: (signal?: AbortSignal) => request<{ user: AuthUser }>('/auth/me', { signal, timeoutMs: 8_000 }),
  login: (username: string, password: string, signal?: AbortSignal) => request<{ user: AuthUser }>('/auth/login', { method: 'POST', body: { username, password }, signal, timeoutMs: 15_000 }),
  logout: (signal?: AbortSignal) => request<{ ok: boolean }>('/auth/logout', { method: 'POST', signal, timeoutMs: 8_000 }),
}
