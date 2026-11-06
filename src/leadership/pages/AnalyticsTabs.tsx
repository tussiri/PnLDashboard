import type { SuiteGroup } from '../routes'
import { useLeadership } from '../state'

type Tab = 'accounts' | 'units' | SuiteGroup
const TABS: { key: Tab; label: string; suite?: boolean }[] = [
  { key: 'accounts', label: 'Accounts' },
  { key: 'units', label: 'Business units' },
  { key: 'finance', label: 'Finance', suite: true },
  { key: 'operations', label: 'Operations', suite: true },
]

/** Analytics tab row. Finance and Operations (the analytics suite, src/suite) exist for super administrators only. */
export function AnalyticsTabs() {
  const { route, navigate, superAdmin } = useLeadership()
  const current: Tab = (superAdmin && route.suite?.group) || route.analyticsTab || 'accounts'
  const open = (tab: (typeof TABS)[number]) => navigate(tab.suite
    ? { view: 'analytics', analyticsTab: undefined, suite: { group: tab.key as SuiteGroup }, q: undefined, status: undefined, segment: undefined, site: undefined }
    : { view: 'analytics', analyticsTab: tab.key === 'units' ? 'units' : undefined, suite: undefined })
  return <nav className="tabs" role="tablist" aria-label="Analytics views">
    {TABS.filter((tab) => !tab.suite || superAdmin).map((tab) => <button key={tab.key} type="button" role="tab" className="tab" aria-selected={current === tab.key} onClick={() => open(tab)}>{tab.label}</button>)}
  </nav>
}
