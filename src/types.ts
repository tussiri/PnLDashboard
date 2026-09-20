export type Region = 'Northeast' | 'Southeast' | 'Central' | 'West'
export type JobStatus = 'Healthy' | 'Watch' | 'Critical'
export type ServiceType = 'Janitorial' | 'Industrial' | 'Healthcare' | 'Education'

/** Seeded site record used by the demo dataset (src/data/seed.ts) and the browser-only scenario engine. */
export interface JobSite {
  id: string
  winTeamId: string
  customer: string
  name: string
  city: string
  state: string
  zip: string
  address: string
  country: 'United States' | 'Canada'
  latitude: number
  longitude: number
  region: Region
  branch: string
  siteManager: string
  operationsManager: string
  accountManager: string
  serviceType: ServiceType
  status: JobStatus
  contractStart: string
  contractValue: number
  billingFrequency: 'Monthly' | 'Biweekly'
  revenue: number
  budgetRevenue: number
  labor: number
  laborBudget: number
  supplies: number
  payrollBurden: number
  otherDirectCosts: number
  scheduledHours: number
  actualHours: number
  overtimeHours: number
  payRate: number
  billRate: number
  openReceivables: number
  daysOutstanding: number
  lastInvoiceDate: string
}

export interface MonthlyPerformance {
  month: string
  revenue: number
  budget: number
  labor: number
  grossProfit: number
  ebitda: number
  invoiced: number
  collected: number
  hours: number
  overtime: number
}

export type Period = 'MTD' | 'QTD' | 'YTD' | 'T12M'

/**
 * Reporting scope (docs/api-contract.md, "Reporting scope: key accounts first").
 * `key` = the accounts in the server setting `key_accounts`, `other` = the long tail,
 * `all` = everything. Ignored server-side when a single `account` is selected.
 */
export type ScopeMode = 'key' | 'all' | 'other'

/** Delivery-model filter; `all` is the default and is never sent to the API. */
export type DeliveryFilter = 'all' | 'self_perform' | 'subcontracted'

/**
 * Global reporting filters, scope-first: the views open on the key accounts and reach the
 * long tail by drill-down. Everything except `period`, `scope` and `delivery` is a free-form
 * string matched exactly server-side; '' means "All". `month` is the anchor month
 * (ISO first-of-month) or null for the latest month the marts contain.
 */
export interface GlobalFilters {
  period: Period
  month: string | null
  /** Account grouping when no single `account` is selected. */
  scope: ScopeMode
  /** Drill-down to one parent account (key or other); '' = use `scope`. */
  account: string
  /** Second level under a key account; only meaningful with an `account`. */
  subAccount: string
  delivery: DeliveryFilter
  region: string
  branch: string
  serviceType: string
  vertical: string
  /** Legal entity (finance reference source); '' = all. Ignored by sources that have no companies. */
  company: string
}

export const defaultFilters: GlobalFilters = { period: 'YTD', month: null, scope: 'key', account: '', subAccount: '', delivery: 'all', region: '', branch: '', serviceType: '', vertical: '', company: '' }

export type PageKey =
  | 'overview'
  | 'financial'
  | 'revenue'
  | 'expenses'
  | 'profitability'
  | 'labor'
  | 'timekeeping'
  | 'billing'
  | 'geography'
  | 'budget'
  | 'jobs'
  | 'customers'
  | 'forecast'
  | 'reports'
  | 'alerts'
  | 'data'
  | 'admin'
