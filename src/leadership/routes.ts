/**
 * Hash routes of the leadership dashboard. Every selection that changes what is shown lives in the
 * URL so a view can be shared:
 *
 *   #/home?account=plano-isd&week=2026-09-20&target=64.5
 *   #/account/plano-isd/sites?week=2026-09-20&site=Crane%20Southwest~801
 *   #/account/fedex/sites?delivery=self      (subcontracted sites hidden)
 *   #/analytics?week=2026-09-20&account=other&status=over&q=elementary
 *   #/admin/imports
 *
 * `week` is the week-ending Sunday the views display (the API maps any date to its Monday week);
 * `target` is a percentage (64.5) and overrides the account target while present.
 */

/** company: the landing page. analytics: the Portfolio pages (#/portfolio; #/analytics still opens them). */
export type View = 'company' | 'account' | 'analytics' | 'admin'
export const ACCOUNT_TABS = ['overview', 'sites', 'pallet', 'over-target', 'overtime', 'income-statement', 'subcontracted', 'map', 'vendors', 'feedback'] as const
export type AccountTab = (typeof ACCOUNT_TABS)[number]
export const ADMIN_TABS = ['accounts', 'jobs', 'allocations', 'imports', 'mailbox', 'data', 'users'] as const
export const ANALYTICS_TABS = ['accounts', 'units'] as const
export type AnalyticsTab = (typeof ANALYTICS_TABS)[number]
export type AdminTab = (typeof ADMIN_TABS)[number]

export interface Route {
  view: View
  account?: string
  tab?: AccountTab
  adminTab?: AdminTab
  /** Analytics: the drill-down (accounts) or the business units overview (units). */
  analyticsTab?: AnalyticsTab
  week?: string
  target?: number
  /** Site drawer: company and job number. */
  site?: { company: string; job: string }
  /** Analytics filters. */
  q?: string
  status?: string
  segment?: string
  /** Account view: hide subcontracted sites. */
  selfOnly?: boolean
  /** Invoice basis override (the FedEx report's toggle); the account's own basis when absent. */
  basis?: 'run_rate_3m' | 'last_month'
  /** Home and Account: the month-end rollup instead of a week. */
  period?: 'month'
  /** The month shown in the month-end rollup (YYYY-MM); the selected week's month when absent. */
  month?: string
}

const ISO = /^\d{4}-\d{2}-\d{2}$/
const SITE_SEP = '~'

export function parseRoute(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?')
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
  const params = new URLSearchParams(query)
  const route: Route = { view: 'company' }
  const [first, second, third] = parts
  if (first === 'account') {
    route.view = 'account'
    if (second) route.account = second
    route.tab = (ACCOUNT_TABS as readonly string[]).includes(third ?? '') ? (third as AccountTab) : 'overview'
  } else if (first === 'analytics' || first === 'portfolio') {
    route.view = 'analytics'
    if (second === 'units') route.analyticsTab = 'units'
  } else if (first === 'company') route.view = 'company'
  else if (first === 'admin') {
    route.view = 'admin'
    route.adminTab = (ADMIN_TABS as readonly string[]).includes(second ?? '') ? (second as AdminTab) : 'accounts'
  }
  const account = params.get('account')
  // The retired Home page (#/?account=, #/home?account=) was one account's summary: open that account.
  if (account && (!first || first === 'home') && route.view === 'company') { route.view = 'account'; route.tab = 'overview' }
  if (account) route.account = account
  const week = params.get('week')
  if (week && ISO.test(week)) route.week = week
  const target = Number(params.get('target'))
  if (params.get('target') && Number.isFinite(target) && target > 0 && target < 200) route.target = target
  const site = params.get('site')
  if (site && site.includes(SITE_SEP)) {
    const i = site.lastIndexOf(SITE_SEP)
    route.site = { company: site.slice(0, i), job: site.slice(i + 1) }
  }
  for (const key of ['q', 'status', 'segment'] as const) {
    const value = params.get(key)
    if (value) route[key] = value
  }
  if (route.view === 'account' && params.get('delivery') === 'self') route.selfOnly = true
  const basis = params.get('basis')
  if (basis === 'run_rate_3m' || basis === 'last_month') route.basis = basis
  if (params.get('period') === 'month' && route.view === 'account') route.period = 'month'
  const month = params.get('month')
  if (route.period && month && /^\d{4}-\d{2}$/.test(month)) route.month = month
  return route
}

export function formatRoute(route: Route): string {
  const path = route.view === 'account'
    ? `account/${encodeURIComponent(route.account ?? '')}${route.tab && route.tab !== 'overview' ? `/${route.tab}` : ''}`
    : route.view === 'admin'
      ? `admin${route.adminTab && route.adminTab !== 'accounts' ? `/${route.adminTab}` : ''}`
      : route.view === 'analytics' ? (route.analyticsTab === 'units' ? 'portfolio/units' : 'portfolio') : route.view
  const params = new URLSearchParams()
  if (route.account && route.view !== 'account' && route.view !== 'admin') params.set('account', route.account)
  if (route.week && route.view !== 'admin') params.set('week', route.week)
  if (route.target != null && route.view !== 'admin') params.set('target', String(route.target))
  if (route.site && route.view !== 'admin') params.set('site', `${route.site.company}${SITE_SEP}${route.site.job}`)
  if (route.view === 'analytics') for (const key of ['q', 'status', 'segment'] as const) if (route[key]) params.set(key, route[key]!)
  if (route.view === 'account' && route.selfOnly) params.set('delivery', 'self')
  if (route.basis && route.view !== 'admin') params.set('basis', route.basis)
  if (route.period === 'month' && route.view === 'account') {
    params.set('period', 'month')
    if (route.month) params.set('month', route.month)
  }
  const query = params.toString()
  return `#/${path}${query ? `?${query}` : ''}`
}

/** ISO date `days` after an ISO date. */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The Sunday a Monday-based week ends on. */
export const weekEndOf = (weekStart: string) => addDays(weekStart, 6)
/** The Monday of the week containing a date. */
export function weekStartOf(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`)
  return addDays(iso, -((d.getUTCDay() + 6) % 7))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const parts = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return { y, m, d } }
/** "Week ending Sep 20, 2026" from a week start. */
export function weekLabel(weekStart: string): string {
  const { y, m, d } = parts(weekEndOf(weekStart))
  return `Week ending ${MONTHS[m - 1]} ${d}, ${y}`
}
/** "Sep 20" from a week start (chart ticks). */
export function weekTick(weekStart: string): string {
  const { m, d } = parts(weekEndOf(weekStart))
  return `${MONTHS[m - 1]} ${d}`
}
/** "Aug 2026" from a month. */
export function monthLabel(iso: string | null | undefined): string {
  if (!iso) return ''
  const { y, m } = parts(iso)
  return `${MONTHS[m - 1]} ${y}`
}
/** "Aug" from a month. */
export const monthShort = (iso: string | null | undefined) => (iso ? MONTHS[parts(iso).m - 1] : '')
