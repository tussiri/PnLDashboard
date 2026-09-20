import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { LoginPage } from './auth/LoginPage'
import { ALL_PAGES, canAccess, homeFor, type AuthUser } from './auth/roles'
import { AuthProvider, useAuth } from './auth/useAuth'
import { FilterBar, Sidebar, TopBar, asOfDate, primarySourceOf } from './components/AppShell'
import { Skeleton } from './components/CardState'
import { DashboardProvider, useDashboard } from './context/DashboardContext'
import type { PageKey } from './types'
import { fmtDate } from './utils'
import { Admin } from './views/Admin'
import { Alerts } from './views/Alerts'
import { Billing } from './views/Billing'
import { Budget } from './views/Budget'
import { Customers } from './views/Customers'
import { DataDictionary } from './views/DataDictionary'
import { Expenses } from './views/Expenses'
import { Financial } from './views/Financial'
import { Forecast } from './views/Forecast'
import { Geography } from './views/Geography'
import { JobDetail } from './views/JobDetail'
import { Jobs } from './views/Jobs'
import { Labor } from './views/Labor'
import { Overview } from './views/Overview'
import { Profitability } from './views/Profitability'
import { Reports } from './views/Reports'
import { Revenue } from './views/Revenue'
import { EXECUTIVE_VIEW_KEYS } from './views/shared'
import { Timekeeping } from './views/Timekeeping'

export const validPages = new Set<PageKey>(ALL_PAGES)
/** Views whose numbers truthfully change with the global period/dimension filters (self-contained executive views excluded). */
export const portfolioFilterPages = new Set<PageKey>((['overview', 'financial', 'revenue', 'expenses', 'profitability', 'labor', 'timekeeping', 'billing', 'geography', 'budget', 'jobs', 'customers', 'alerts'] as PageKey[]).filter((page) => !EXECUTIVE_VIEW_KEYS.has(page)))

export function parseHash(hash = location.hash): { page: PageKey; jobNumber: string | null } {
  const [rawPage, jobNumber] = hash.replace(/^#\/?/, '').split('/')
  return { page: validPages.has(rawPage as PageKey) ? (rawPage as PageKey) : 'overview', jobNumber: jobNumber ? decodeURIComponent(jobNumber) : null }
}

const views: Record<PageKey, () => ReactNode> = {
  overview: () => <Overview />, financial: () => <Financial />, revenue: () => <Revenue />, expenses: () => <Expenses />, profitability: () => <Profitability />,
  labor: () => <Labor />, timekeeping: () => <Timekeeping />, billing: () => <Billing />, geography: () => <Geography />, budget: () => <Budget />,
  jobs: () => <Jobs />, customers: () => <Customers />, forecast: () => <Forecast />, reports: () => <Reports />, alerts: () => <Alerts />, data: () => <DataDictionary />, admin: () => <Admin />,
}

const BootSkeleton = ({ label }: { label: string }) => <div className="boot-grid" aria-busy="true" aria-label={label}><Skeleton variant="kpi" /><Skeleton variant="kpi" /><Skeleton variant="kpi" /><Skeleton variant="kpi" /><div className="boot-grid__wide"><Skeleton variant="chart" height={260} /></div></div>

function Shell({ user, onSignOut }: { user: AuthUser; onSignOut: () => void }) {
  const { ready, mode, decision, systemStatus, lastSource, refreshStatus, filters, setFilters, resetFilters, dimensions, resolvedRange, verticalLabels, latestMonth, page, jobNumber, navigate, toasts, dismissToast } = useDashboard()
  const [mobileNav, setMobileNav] = useState(false)
  const allowed = canAccess(user.role, page)
  // Routes outside the role's set redirect to the role's landing view.
  useEffect(() => { if (!allowed) navigate(homeFor(user.role)) }, [allowed, navigate, user.role])
  const executive = user.role === 'executive'
  const usesFilters = allowed && portfolioFilterPages.has(page) && !executive
  let content: ReactNode
  if (!ready) content = <BootSkeleton label="Connecting to the reporting API" />
  else if (!allowed) content = null
  else if (page === 'jobs' && jobNumber) content = <JobDetail jobNumber={jobNumber} />
  else content = views[page]()
  const asOf = asOfDate(lastSource, systemStatus)
  const footerLine = mode === 'live'
    ? ['Crane IFS', primarySourceOf(lastSource, systemStatus).label ?? 'Reporting marts', asOf ? `as of ${fmtDate(asOf)}` : null].filter(Boolean).join(' · ')
    : 'Crane IFS · Demo data'
  return <div className="app">
    <a className="skip-link" href="#main-content">Skip to dashboard content</a>
    <Sidebar page={allowed ? page : homeFor(user.role)} open={mobileNav} onClose={() => setMobileNav(false)} onNavigate={navigate} user={user} onSignOut={onSignOut} />
    {mobileNav && <button className="nav-scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation" />}
    <main>
      <TopBar page={allowed ? page : homeFor(user.role)} onMenu={() => setMobileNav(true)} mode={mode} decision={decision} status={systemStatus} source={lastSource} onRefresh={refreshStatus} compact={executive} />
      {ready && decision.banner && <div className={`mode-banner mode-banner--${decision.reason}`} role="status"><Info size={14} aria-hidden="true" /><span>{decision.banner}</span>{!executive && <small>{decision.reason === 'marts_empty' ? 'Load a source from Administration to switch to live data.' : 'Start the API stack or set VITE_API_BASE_URL.'}</small>}</div>}
      {usesFilters && page !== 'geography' && <FilterBar filters={filters} onChange={setFilters} onReset={resetFilters} dimensions={dimensions} range={resolvedRange} verticalLabels={verticalLabels} latestMonth={latestMonth} />}
      <div className="page-content" id="main-content" tabIndex={-1}>{content}</div>
      <footer><span>{footerLine}</span></footer>
    </main>
    <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast toast--${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>{t.kind === 'error' ? <AlertTriangle size={15} /> : t.kind === 'success' ? <CheckCircle2 size={15} /> : <Info size={15} />}<div><strong>{t.title}</strong>{t.detail && <span>{t.detail}</span>}</div><button type="button" onClick={() => dismissToast(t.id)} aria-label="Dismiss"><X size={14} /></button></div>)}</div>
  </div>
}

function Gate() {
  const { status, user, signOut } = useAuth()
  const [route, setRoute] = useState(() => parseHash())
  useEffect(() => {
    const sync = () => setRoute(parseHash())
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])
  const navigate = useCallback((next: PageKey) => { location.hash = `/${next}`; window.scrollTo({ top: 0, behavior: 'auto' }) }, [])
  const openJob = useCallback((jobNumber: string) => { location.hash = `/jobs/${encodeURIComponent(jobNumber)}`; window.scrollTo({ top: 0, behavior: 'auto' }) }, [])
  if (status === 'checking') return <main className="login login--checking" aria-busy="true"><BootSkeleton label="Checking sign-in" /></main>
  if (status === 'signed_out' || !user) return <LoginPage />
  return <DashboardProvider key={user.username} page={route.page} jobNumber={route.jobNumber} navigate={navigate} openJob={openJob}><Shell user={user} onSignOut={() => { void signOut() }} /></DashboardProvider>
}

export default function App() {
  return <AuthProvider><Gate /></AuthProvider>
}
