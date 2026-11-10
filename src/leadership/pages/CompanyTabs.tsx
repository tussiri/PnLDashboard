import { useLeadership } from '../state'

/** Company tab row: the company at a glance and the month-end view (src/leadership/MonthEnd.tsx). */
export function CompanyTabs() {
  const { route, navigate } = useLeadership()
  const monthEnd = route.view === 'company' && !!route.monthEnd
  return <nav className="tabs" role="tablist" aria-label="Company views">
    <button type="button" role="tab" className="tab" aria-selected={!monthEnd} onClick={() => navigate({ view: 'company', monthEnd: undefined })}>At a glance</button>
    <button type="button" role="tab" className="tab" aria-selected={monthEnd} onClick={() => navigate({ view: 'company', monthEnd: route.monthEnd ?? {} })}>Month end</button>
  </nav>
}
