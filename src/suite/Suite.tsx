import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { useCallback, type ReactNode } from 'react'
import { AnalyticsTabs } from '../leadership/pages/AnalyticsTabs'
import { PageHeader } from '../leadership/Shell'
import { useLeadership } from '../leadership/state'
import { Pills } from '../leadership/ui'
import { Skeleton } from './components/CardState'
import { FilterBar, asOfDate, primarySourceOf } from './components/FilterBar'
import { DashboardProvider, useDashboard } from './context/DashboardContext'
import { SUITE_GROUP_LABEL, SUITE_PAGES, resolveSuitePage, suiteGroupOf, type SuitePage } from './pages'
import './suite.css'
import type { PageKey } from './types'
import { fmtDate } from './utils'
import { Billing } from './views/Billing'
import { Budget } from './views/Budget'
import { Customers } from './views/Customers'
import { Expenses } from './views/Expenses'
import { Financial } from './views/Financial'
import { Forecast } from './views/Forecast'
import { Geography } from './views/Geography'
import { JobDetail } from './views/JobDetail'
import { Jobs } from './views/Jobs'
import { Labor } from './views/Labor'
import { Profitability } from './views/Profitability'
import { Revenue } from './views/Revenue'
import { Timekeeping } from './views/Timekeeping'

const VIEWS: Partial<Record<PageKey, () => ReactNode>> = {
  financial: () => <Financial />, revenue: () => <Revenue />, expenses: () => <Expenses />, profitability: () => <Profitability />, billing: () => <Billing />, budget: () => <Budget />, forecast: () => <Forecast />,
  labor: () => <Labor />, timekeeping: () => <Timekeeping />, jobs: () => <Jobs />, customers: () => <Customers />, geography: () => <Geography />,
}

/**
 * The analytics suite: Finance and Operations under Analytics, for super administrators only
 * (src/auth/roles.ts isSuperAdmin; the API enforces the same on the reporting, labor and forecast
 * routes). These are the portfolio views of the retired reporting app, on the monthly marts, with
 * their own period and scope filters. Loaded as a separate chunk from App.tsx.
 */
export default function Suite() {
  const { route, navigate, decision } = useLeadership()
  const group = route.suite?.group ?? 'finance'
  const page = resolveSuitePage(group, route.suite?.page)
  const jobNumber = page.key === 'jobs' ? route.suite?.job ?? null : null

  const open = useCallback((key: PageKey) => {
    const target = suiteGroupOf(key)
    if (!target) return
    navigate({ view: 'analytics', suite: { group: target, page: key } })
    window.scrollTo({ top: 0 })
  }, [navigate])
  const openJob = useCallback((job: string) => {
    navigate({ view: 'analytics', suite: { group: 'operations', page: 'jobs', job } })
    window.scrollTo({ top: 0 })
  }, [navigate])

  if (!decision) return null
  return <DashboardProvider key={decision.mode} page={page.key} jobNumber={jobNumber} navigate={open} openJob={openJob} forcedDecision={decision}>
    <SuiteHeader page={page} />
    <AnalyticsTabs />
    <Pills label={`${SUITE_GROUP_LABEL[group]} views`} value={page.key} onChange={open} options={SUITE_PAGES[group].map((p) => ({ value: p.key, label: p.label }))} />
    <SuiteBody page={page} />
  </DashboardProvider>
}

function SuiteHeader({ page }: { page: SuitePage }) {
  const { mode, lastSource, systemStatus } = useDashboard()
  const asOf = asOfDate(lastSource, systemStatus)
  const subtitle = [page.title, mode === 'live' ? primarySourceOf(lastSource, systemStatus).label : null, mode === 'live' && asOf ? `As of ${fmtDate(asOf)}` : null].filter(Boolean).join('. ')
  return <PageHeader title="Portfolio" subtitle={subtitle} account={false} week={false} target={false} />
}

function SuiteBody({ page }: { page: SuitePage }) {
  const { ready, filters, setFilters, resetFilters, dimensions, resolvedRange, verticalLabels, latestMonth, jobNumber, toasts, dismissToast } = useDashboard()
  return <div className="suite">
    {page.filters && <FilterBar filters={filters} onChange={setFilters} onReset={resetFilters} dimensions={dimensions} range={resolvedRange} verticalLabels={verticalLabels} latestMonth={latestMonth} />}
    <div className="page-content">
      {!ready
        ? <div className="boot-grid" aria-busy="true" aria-label="Connecting to the reporting API"><Skeleton variant="kpi" /><Skeleton variant="kpi" /><Skeleton variant="kpi" /><Skeleton variant="kpi" /><div className="boot-grid__wide"><Skeleton variant="chart" height={260} /></div></div>
        : page.key === 'jobs' && jobNumber ? <JobDetail jobNumber={jobNumber} /> : VIEWS[page.key]?.()}
    </div>
    <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast toast--${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>{t.kind === 'error' ? <AlertTriangle size={15} /> : t.kind === 'success' ? <CheckCircle2 size={15} /> : <Info size={15} />}<div><strong>{t.title}</strong>{t.detail && <span>{t.detail}</span>}</div><button type="button" onClick={() => dismissToast(t.id)} aria-label="Dismiss"><X size={14} /></button></div>)}</div>
  </div>
}
