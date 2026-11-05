import type { SuiteGroup } from '../leadership/routes'
import type { PageKey } from './types'

/** filters: the view's numbers follow the period and scope filter bar. */
export interface SuitePage { key: PageKey; label: string; title: string; filters: boolean }

/** The analytics suite: the portfolio views of the retired reporting app, grouped as its navigation was. */
export const SUITE_PAGES: Record<SuiteGroup, SuitePage[]> = {
  finance: [
    { key: 'financial', label: 'Financial summary', title: 'Financial Summary', filters: true },
    { key: 'revenue', label: 'Revenue analysis', title: 'Revenue Analysis', filters: true },
    { key: 'expenses', label: 'Cost analysis', title: 'Cost Analysis', filters: true },
    { key: 'profitability', label: 'Margin & profitability', title: 'Margin & Profitability', filters: true },
    { key: 'billing', label: 'Billing & receivables', title: 'Billing & Receivables', filters: true },
    { key: 'budget', label: 'Budget vs actual', title: 'Budget vs Actual', filters: true },
    { key: 'forecast', label: 'Forecast', title: 'Forecast', filters: false },
  ],
  operations: [
    { key: 'labor', label: 'Labor cost', title: 'Labor Cost', filters: true },
    { key: 'timekeeping', label: 'Hours & timekeeping', title: 'Hours & Timekeeping', filters: true },
    { key: 'jobs', label: 'Sites portfolio', title: 'Sites Portfolio', filters: true },
    { key: 'customers', label: 'Account portfolio', title: 'Account Portfolio', filters: true },
    // The map carries its own filter row.
    { key: 'geography', label: 'Geographic operations', title: 'Geographic Operations', filters: false },
  ],
}

export const SUITE_GROUP_LABEL: Record<SuiteGroup, string> = { finance: 'Finance', operations: 'Operations' }

/** The page a suite route selects; an unknown or absent page is the group's first. */
export function resolveSuitePage(group: SuiteGroup, page: string | undefined): SuitePage {
  return SUITE_PAGES[group].find((p) => p.key === page) ?? SUITE_PAGES[group][0]
}

/** Which group holds a page of the retired app; undefined for the pages that were not carried over. */
export function suiteGroupOf(page: PageKey): SuiteGroup | undefined {
  return (Object.keys(SUITE_PAGES) as SuiteGroup[]).find((group) => SUITE_PAGES[group].some((p) => p.key === page))
}
