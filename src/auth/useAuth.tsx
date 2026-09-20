import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ApiError, UNAUTHORIZED_EVENT } from '../services/api'
import { queryClient } from '../services/queryClient'
import { authApi, type AuthMode } from './authApi'
import { demoAuthenticate, type AuthUser } from './roles'

/**
 * Where sign-in is decided:
 *   api   the reporting API answered /auth/mode; sessions are HttpOnly cookies issued by /auth/login
 *   demo  no API is reachable; a browser-only sign-in accepts the three development users so the
 *         labeled demo dataset can still be explored (nothing is sent anywhere)
 */
export type AuthBackend = 'api' | 'demo'
export type AuthStatus = 'checking' | 'signed_out' | 'signed_in'

export interface AuthState {
  status: AuthStatus
  user: AuthUser | null
  backend: AuthBackend
  /** The API's sign-in mode (dev shows the development-user notice); null until known or in demo. */
  apiMode: AuthMode | null
  signIn: (username: string, password: string) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)
const DEMO_SESSION_KEY = 'crane-ifs-demo-session'

/**
 * Whether a failed GET /auth/mode means "no API here": a network error or timeout, a 5xx, or a 404
 * (`NO_API_PROXY=1 pnpm dev` has Vite answer /api/v1/* with 404). Any other 4xx is a reachable API
 * that refused the call, so the real sign-in stays.
 */
export const apiAbsent = (error: unknown): boolean => !(error instanceof ApiError && !error.isNetwork && error.status < 500 && error.status !== 404)

function readDemoSession(): AuthUser | null {
  try {
    const raw = sessionStorage.getItem(DEMO_SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as AuthUser
    return demoAuthenticate(parsed.username, `dev-${parsed.username}`) ? parsed : null
  } catch { return null }
}

export function AuthProvider({ children, forced }: { children: ReactNode; forced?: Pick<AuthState, 'status' | 'user' | 'backend' | 'apiMode'> }) {
  const [status, setStatus] = useState<AuthStatus>(forced?.status ?? 'checking')
  const [user, setUser] = useState<AuthUser | null>(forced?.user ?? null)
  const [backend, setBackend] = useState<AuthBackend>(forced?.backend ?? 'api')
  const [apiMode, setApiMode] = useState<AuthMode | null>(forced?.apiMode ?? null)

  useEffect(() => {
    if (forced) return
    const controller = new AbortController()
    ;(async () => {
      try {
        const { mode } = await authApi.mode(controller.signal)
        setApiMode(mode); setBackend('api')
        try {
          const { user } = await authApi.me(controller.signal)
          setUser(user); setStatus('signed_in')
        } catch (error) {
          if (controller.signal.aborted) return
          setUser(null); setStatus('signed_out')
          void error
        }
      } catch (error) {
        if (controller.signal.aborted) return
        if (!apiAbsent(error)) { setBackend('api'); setStatus('signed_out'); return }
        setBackend('demo'); setApiMode(null)
        const existing = readDemoSession()
        setUser(existing); setStatus(existing ? 'signed_in' : 'signed_out')
      }
    })()
    return () => controller.abort()
  }, [forced])

  // A 401 from any data call (expired cookie, restarted API with a new secret) returns to the login page.
  useEffect(() => {
    if (backend !== 'api') return
    const onUnauthorized = () => { setUser(null); setStatus('signed_out'); queryClient.invalidate() }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [backend])

  const signIn = useCallback(async (username: string, password: string) => {
    if (backend === 'demo') {
      const found = demoAuthenticate(username, password)
      if (!found) throw new ApiError(401, 'Invalid username or password', '/auth/login')
      try { sessionStorage.setItem(DEMO_SESSION_KEY, JSON.stringify(found)) } catch { /* private mode */ }
      setUser(found); setStatus('signed_in')
      return
    }
    const { user } = await authApi.login(username, password)
    queryClient.invalidate()
    setUser(user); setStatus('signed_in')
  }, [backend])

  const signOut = useCallback(async () => {
    if (backend === 'api') { try { await authApi.logout() } catch { /* cookie may already be gone */ } }
    try { sessionStorage.removeItem(DEMO_SESSION_KEY) } catch { /* ignore */ }
    setUser(null); setStatus('signed_out')
    queryClient.invalidate()
  }, [backend])

  const value = useMemo<AuthState>(() => ({ status, user, backend, apiMode, signIn, signOut }), [status, user, backend, apiMode, signIn, signOut])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
