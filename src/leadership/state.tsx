import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useApiQuery, type QueryState } from '../hooks/useApiQuery'
import type { LeadershipAccount, LeadershipConfig } from '../services/apiTypes'
import { apiFor, detectMode, type DashboardApi, type ModeDecision } from '../services/dataSource'
import { queryKey } from '../services/queryClient'
import type { AuthUser } from '../auth/roles'
import type { MetricOptions } from './metrics'
import { formatRoute, parseRoute, weekEndOf, weekStartOf, type Route } from './routes'

export type Theme = 'system' | 'light' | 'dark'
const THEME_KEY = 'crane-ifs-theme'

export interface LeadershipState {
  user: AuthUser
  signOut: () => void
  decision: ModeDecision | null
  api: DashboardApi
  /** Prefix for cache keys so live and demo data never mix. */
  keyPrefix: string
  /**
   * Admin data actions (sync, rebuild, imports, users): the live API whenever it is reachable, even
   * while the views show demo data because the marts are still empty, so an empty database can be
   * filled from the dashboard. The demo stand-in only when no API answers.
   */
  adminApi: DashboardApi
  adminKeyPrefix: string
  /** The API's own configuration (accounts) for Admin; the views' `config` is the demo one while demo. */
  adminConfig: QueryState<LeadershipConfig>
  apiReachable: boolean
  /** Decide live or demo again (after a sync, rebuild or import fills the marts). */
  redetect: () => void
  config: QueryState<LeadershipConfig>
  route: Route
  navigate: (next: Partial<Route>, options?: { replace?: boolean; reset?: boolean }) => void
  featured: LeadershipAccount[]
  accountBySlug: (slug: string | undefined) => LeadershipAccount | undefined
  /** The account the route selects, else the first featured account with sites. */
  selectedAccount: LeadershipAccount | undefined
  /** Monday of the selected week. */
  weekStart: string | undefined
  /** Target override from the URL as a fraction; null when the account targets apply. */
  targetOverride: number | null
  optionsFor: (account: LeadershipAccount | undefined) => MetricOptions
  theme: Theme
  setTheme: (theme: Theme) => void
}

const Ctx = createContext<LeadershipState | null>(null)

export function useLeadership(): LeadershipState {
  const value = useContext(Ctx)
  if (!value) throw new Error('useLeadership outside LeadershipProvider')
  return value
}

function readTheme(): Theme {
  try { const t = localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : 'system' } catch { return 'system' }
}

/** Metric options for an account: its target (or the URL override, which also drops segment targets), method, divisor and cost basis. */
export function optionsForAccount(account: LeadershipAccount | undefined, override: number | null): MetricOptions {
  if (!account) return { target: override ?? 0.645 }
  const segmentTargets = override != null ? undefined
    : Object.fromEntries(account.segments.filter((s) => s.target_labor_pct != null).map((s) => [s.name, s.target_labor_pct as number]))
  return {
    target: override ?? account.target_labor_pct,
    watchBand: account.watch_band,
    revenueMethod: account.revenue_method === 'weekly_billing' ? 'weekly_billing' : 'monthly_div',
    divisor: account.revenue_divisor,
    budgetReliabilityRatio: account.budget_reliability_ratio,
    costBasis: account.cost_basis,
    segmentTargets,
  }
}

export function LeadershipProvider({ user, signOut, children, forcedDecision }: { user: AuthUser; signOut: () => void; children: ReactNode; forcedDecision?: ModeDecision }) {
  const [decision, setDecision] = useState<ModeDecision | null>(forcedDecision ?? null)
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash))
  const [theme, setThemeState] = useState<Theme>(readTheme)

  const [detection, setDetection] = useState(0)
  useEffect(() => {
    if (forcedDecision) return
    const controller = new AbortController()
    detectMode(controller.signal).then(setDecision).catch(() => { /* aborted */ })
    return () => controller.abort()
  }, [forcedDecision, detection])
  const redetect = useCallback(() => setDetection((n) => n + 1), [])

  useEffect(() => {
    const sync = () => setRoute(parseRoute(location.hash))
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    try { if (theme === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, theme) } catch { /* storage unavailable */ }
  }, [theme])

  const mode = decision?.mode ?? 'demo'
  const api = useMemo(() => apiFor(mode), [mode])
  const keyPrefix = decision ? mode : 'pending'
  const apiReachable = Boolean(decision && decision.reason !== 'unreachable')
  const adminApi = useMemo(() => (apiReachable ? apiFor('live') : api), [apiReachable, api])
  const adminKeyPrefix = decision ? (apiReachable ? 'live' : 'demo') : 'pending'

  const config = useApiQuery<LeadershipConfig>(decision ? queryKey(`${keyPrefix}/leadership/config`) : null, (signal) => api.leadershipConfig(signal), [api])
  const liveAdminConfig = useApiQuery<LeadershipConfig>(decision && apiReachable && mode === 'demo' ? queryKey('live/leadership/config') : null,
    (signal) => adminApi.leadershipConfig(signal), [adminApi])
  const adminConfig = apiReachable && mode === 'demo' ? liveAdminConfig : config

  const navigate = useCallback((next: Partial<Route>, options: { replace?: boolean; reset?: boolean } = {}) => {
    const current = parseRoute(location.hash)
    const merged: Route = options.reset ? { view: next.view ?? current.view, account: current.account, week: current.week, target: current.target, ...next } : { ...current, ...next }
    const hash = formatRoute(merged)
    if (hash === location.hash) return
    if (options.replace) { history.replaceState(null, '', hash); setRoute(parseRoute(hash)) }
    else { location.hash = hash; if (next.view && next.view !== current.view) window.scrollTo({ top: 0 }) }
  }, [])

  const accounts = config.data?.accounts
  const featured = useMemo(() => (accounts ?? []).filter((a) => a.featured).sort((a, b) => a.sort - b.sort), [accounts])
  const accountBySlug = useCallback((slug: string | undefined) => (accounts ?? []).find((a) => a.slug === slug), [accounts])
  const selectedAccount = accountBySlug(route.account) ?? featured.find((a) => a.sites > 0) ?? featured[0]
  const defaultWeek = config.data?.default_week ?? undefined
  const weekStart = route.week ? weekStartOf(route.week) : defaultWeek
  const targetOverride = route.target != null ? route.target / 100 : null
  const optionsFor = useCallback((account: LeadershipAccount | undefined) => optionsForAccount(account, targetOverride), [targetOverride])

  const value: LeadershipState = {
    user, signOut, decision, api, keyPrefix, adminApi, adminKeyPrefix, adminConfig, apiReachable, redetect, config, route, navigate, featured, accountBySlug, selectedAccount,
    weekStart, targetOverride, optionsFor, theme, setTheme: setThemeState,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** The week-ending date the URL carries for a week start. */
export const weekParam = (weekStart: string) => weekEndOf(weekStart)
