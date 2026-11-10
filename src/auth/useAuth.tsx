import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ApiError, UNAUTHORIZED_EVENT } from '../services/api'
import { queryClient } from '../services/queryClient'
import { authApi, type AuthMode, type SignInOptions } from './authApi'
import { demoAuthenticate, type AuthUser } from './roles'

/**
 * Where sign-in is decided:
 *   api          the reporting API answered /auth/mode; sessions are HttpOnly cookies issued by /auth/login
 *   demo         no API is reachable in a development build; a browser-only sign-in accepts the three
 *                development users so the labeled demo dataset can still be explored (nothing is sent anywhere)
 *   unavailable  no API is reachable in a production build: no sign-in is offered, and /auth/mode is retried
 *                until the API answers (a deploy or restart in progress, or the API is down)
 */
export type AuthBackend = 'api' | 'demo' | 'unavailable'
export type AuthStatus = 'checking' | 'signed_out' | 'signed_in'

export interface AuthState {
  status: AuthStatus
  user: AuthUser | null
  backend: AuthBackend
  /** The API's sign-in mode (dev shows the development-user notice); null until known or in demo. */
  apiMode: AuthMode | null
  /** Microsoft sign-in and the password rule; passwords for everyone until the API says otherwise. */
  signInOptions: SignInOptions
  signIn: (username: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  /** Ask /auth/mode again now (the unavailable page's button). */
  retry: () => void
}

const AuthContext = createContext<AuthState | null>(null)
const DEMO_SESSION_KEY = 'crane-ifs-demo-session'
/** How long to wait before asking /auth/mode again while the API is unreachable. */
export const API_RETRY_MS = 10_000

/**
 * Whether the browser-only demo sign-in may be offered: development builds only, or a build made with
 * VITE_DEMO_SIGN_IN=true on purpose. A production build never offers it, so a deploy or an API outage
 * cannot put development accounts on the live sign-in page.
 */
export const demoSignInAllowed = (env: { DEV?: boolean; VITE_DEMO_SIGN_IN?: string } = import.meta.env): boolean =>
  env.DEV === true || env.VITE_DEMO_SIGN_IN === 'true'

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
  const [signInOptions, setSignInOptions] = useState<SignInOptions>({ microsoft: false, password: 'all' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (forced) return
    const controller = new AbortController()
    ;(async () => {
      try {
        const { mode, microsoft, password } = await authApi.mode(controller.signal)
        setApiMode(mode); setBackend('api')
        setSignInOptions({ microsoft: microsoft === true, password: password === 'admins' ? 'admins' : 'all' })
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
        setApiMode(null)
        if (!demoSignInAllowed()) { setBackend('unavailable'); setUser(null); setStatus('signed_out'); return }
        setBackend('demo')
        const existing = readDemoSession()
        setUser(existing); setStatus(existing ? 'signed_in' : 'signed_out')
      }
    })()
    return () => controller.abort()
  }, [forced, attempt])

  // Unreachable API in production: ask again until it answers, then the real sign-in appears on its own.
  useEffect(() => {
    if (forced || backend !== 'unavailable') return
    const timer = window.setTimeout(() => setAttempt((n) => n + 1), API_RETRY_MS)
    return () => window.clearTimeout(timer)
  }, [forced, backend, attempt])

  // A 401 from any data call (expired cookie, restarted API with a new secret) returns to the login page.
  useEffect(() => {
    if (backend !== 'api') return
    const onUnauthorized = () => { setUser(null); setStatus('signed_out'); queryClient.invalidate() }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [backend])

  const signIn = useCallback(async (username: string, password: string) => {
    if (backend === 'unavailable') throw new ApiError(503, 'The dashboard is unavailable right now. Try again in a minute.', '/auth/login')
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

  const retry = useCallback(() => { setStatus('checking'); setAttempt((n) => n + 1) }, [])

  const value = useMemo<AuthState>(() => ({ status, user, backend, apiMode, signInOptions, signIn, signOut, retry }), [status, user, backend, apiMode, signInOptions, signIn, signOut, retry])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
