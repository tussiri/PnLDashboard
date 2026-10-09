/**
 * Metric definitions for the Company page's "At a glance" story, each with its denominator. MetricLabel
 * shows them on hover and focus; docs/METRICS.md carries the same entries. A figure on the story without
 * an entry here does not compile.
 */
export interface MetricDefinition {
  term: string
  definition: string
  /** The formula in the words the code uses. */
  formula?: string
  /** Censoring rules and source limits. */
  caveat?: string
}

const CLOSED = 'Job-cost-closed months only: a month is closed when it has revenue and its job cost direct labor is at least 70% of timekeeping labor (or there is no timekeeping). Open months are shown but not counted.'

export const GLOSSARY = {
  storyRevenue: {
    term: 'Revenue',
    definition: 'Job cost revenue of every account over the closed months of the last 12 months the job cost covers.',
    formula: 'sum(revenue) over closed months in the window',
    caveat: CLOSED,
  },
  storyRevenueTrend: {
    term: 'Last 3 months',
    definition: 'Revenue of the latest 3 closed months against the 3 closed months before them.',
    formula: 'sum(revenue, latest 3 closed) / sum(revenue, 3 closed before) - 1',
    caveat: 'A dash until there are 6 closed months in the window.',
  },
  storyGrossMargin: {
    term: 'Gross margin',
    definition: 'Gross profit as a share of revenue, over the same closed months.',
    formula: 'sum(gross_profit) / sum(revenue)',
    caveat: CLOSED,
  },
  storyLaborPct: {
    term: 'Labor %',
    definition: 'Job cost direct labor as a share of revenue, over the same closed months.',
    formula: 'sum(direct_labor) / sum(revenue)',
    caveat: CLOSED,
  },
  storyPer100: {
    term: 'Of every $100 billed',
    definition: 'Where each $100 of closed-month revenue went, rounded to whole dollars that sum to 100 (largest remainder).',
    formula: 'part / sum(revenue); other job cost = revenue - gross_profit - direct_labor - subcontractors - payroll_taxes',
    caveat: 'Not drawn when gross profit is negative or the costs do not reconcile to gross profit.',
  },
  storyAccountShare: {
    term: 'Largest account',
    definition: 'The featured account with the most closed-month revenue, as a share of revenue of every account.',
    formula: 'account revenue / sum(revenue)',
    caveat: 'Accounts that are not featured count together as Other accounts. ' + CLOSED,
  },
  storyAccountMargin: {
    term: 'Accounts below zero',
    definition: 'Featured accounts whose closed-month gross profit is negative, of the featured accounts with revenue.',
    formula: 'count(accounts where sum(gross_profit) < 0)',
    caveat: CLOSED,
  },
  storyOverTarget: {
    term: 'Over target',
    definition: 'Featured accounts whose labor % in the week is above their target plus the watch band, of the accounts with billing that week.',
    formula: 'count(labor % > target + watch band) / count(accounts with invoicing)',
    caveat: 'The latest complete week unless another week is selected; a week is complete once its Sunday is past the last data rebuild. Labor is the Pay Report, else WinTeam hours at payroll rates, else a trailing-rate estimate; overtime dollars are estimated.',
  },
  storyHoursOver: {
    term: 'Hours over target',
    definition: 'Hours that would bring each featured account to its labor target in the week: sites over target plus catch-all jobs in full.',
    formula: 'sum(header hours over target) over accounts with invoicing',
  },
  storyPlanVariance: {
    term: 'Labor against budget',
    definition: 'Labor of the accounts with a labor budget, against the sum of their budgets, over finished months in the window.',
    formula: 'sum(actual labor) / sum(budget labor) - 1, per month counting only accounts with both',
    caveat: 'Actual is job cost when the month is closed, else the month rollup from timekeeping.',
  },
  storyPlanAccounts: {
    term: 'Accounts with a budget',
    definition: 'Accounts with a labor budget and an actual for at least one finished month in the window.',
  },
  storyAfterAllocations: {
    term: 'After allocations',
    definition: 'Gross profit less management wages, burden and overhead, over the closed months in the window.',
    formula: 'sum(gross_profit - management_wages - burden - overhead)',
    caveat: 'Only the allocations turned on in Admin, Allocations. ' + CLOSED,
  },
  storyAfterAllocationsShare: {
    term: 'Share of revenue',
    definition: 'Gross profit after allocations as a share of revenue, over the same closed months.',
    formula: 'sum(after allocations) / sum(revenue)',
  },
} satisfies Record<string, MetricDefinition>

export type GlossaryKey = keyof typeof GLOSSARY
