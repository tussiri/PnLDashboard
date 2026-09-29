/**
 * Demo data for the leadership labor P&L routes, shown only when the API is unreachable or the marts
 * are empty (the shell labels it demo). Plano ISD uses the reference dashboard's own week (ending
 * 2026-09-20); earlier weeks and the other featured accounts are derived from it deterministically,
 * so every view has plausible, stable numbers without inventing a second data set.
 */
import fixture from '../leadership/fixtures/plano-we-2026-09-20.json'
import type {
  LeadershipAccount, LeadershipRole, LeadershipConfig, LeadershipRow, LeadershipRowsQuery, LeadershipRowsResponse, LeadershipSiteResponse, LeadershipVendorsResponse, LeadershipWeek, SourceBlock,
  StaffingJobResponse, StaffingRequestLine,
} from './apiTypes'

export const DEMO_LEADERSHIP_WEEK = '2026-09-14'
const WEEKS_BACK = 13
const source: SourceBlock = { mode: 'empty', as_of: '2026-09-21T06:00:00Z', latest_month: '2026-08-01', stale: false, primary_source: 'none', ar_as_of: null }

interface DemoAccountSpec { slug: string; name: string; sort: number; segments: string[]; fallback: string; company: string; sites: number; scale: number; target?: number }
const SCHOOL = fixture.segments
const SPECS: DemoAccountSpec[] = [
  { slug: 'amazon', name: 'Amazon', sort: 1, segments: ['Crane IFS', 'Crane West'], fallback: 'Crane IFS', company: 'Crane IFS', sites: 14, scale: 6.5 },
  { slug: 'fedex', name: 'FedEx', sort: 2, segments: ['FedEx Express (FXE)', 'FedEx Ground (FXG)', 'FedEx'], fallback: 'FedEx', company: 'Crane IFS', sites: 24, scale: 1.1 },
  { slug: 'plano-isd', name: 'Plano ISD', sort: 3, segments: SCHOOL, fallback: 'Support & Special Programs', company: 'Crane Southwest', sites: 0, scale: 1 },
  { slug: 'white-settlement-isd', name: 'White Settlement ISD', sort: 4, segments: SCHOOL, fallback: 'Support & Special Programs', company: 'Crane IFS', sites: 12, scale: 1.3 },
  { slug: 'henderson-isd', name: 'Henderson ISD', sort: 5, segments: SCHOOL, fallback: 'Support & Special Programs', company: 'Crane Southwest', sites: 9, scale: 1.2 },
  { slug: 'aldi', name: 'Aldi', sort: 6, segments: ['Stores'], fallback: 'Stores', company: 'Crane IFS', sites: 6, scale: 0.8 },
  { slug: 'whole-foods', name: 'Whole Foods', sort: 7, segments: ['Stores'], fallback: 'Stores', company: 'Crane West', sites: 8, scale: 0.9 },
  { slug: 'apple-retail', name: 'Apple / Retail', sort: 8, segments: ['Stores'], fallback: 'Stores', company: 'Crane IFS', sites: 0, scale: 0 },
]

const iso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (week: string, days: number) => { const d = new Date(`${week}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return iso(d) }
/** Deterministic multiplier in [1 - spread, 1 + spread] from a string key. */
function jitter(key: string, spread: number): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i += 1) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) }
  return 1 + (((h >>> 0) % 2001) / 1000 - 1) * spread
}
const round2 = (v: number) => Math.round(v * 100) / 100

const demoWeeks = (): string[] => Array.from({ length: WEEKS_BACK + 1 }, (_, i) => addDays(DEMO_LEADERSHIP_WEEK, (i - WEEKS_BACK) * 7))

function baseRows(): LeadershipRow[] {
  const plano = fixture.rows.map((r) => ({ ...r, role: r.role as LeadershipRole, account_slug: 'plano-isd', company: 'Crane Southwest', parent_account: 'Plano ISD' }))
  const others = SPECS.filter((s) => s.sites > 0).flatMap((spec) =>
    Array.from({ length: spec.sites }, (_, i) => {
      const src = fixture.rows[(i * 7 + spec.sort) % fixture.rows.length]
      const site = src.role === 'site' ? src : fixture.rows[1 + (i % 80)]
      const k = jitter(`${spec.slug}-${i}`, 0.25) * spec.scale
      return {
        ...site,
        job_number: `${spec.sort}${String(100 + i)}`,
        site_name: `${spec.name} site ${i + 1}`,
        segment: spec.segments[i % spec.segments.length],
        role: 'site' as const,
        revenue_month_amount: Math.round(site.revenue_month_amount * k),
        labor: round2(site.labor * k * jitter(`${spec.slug}-lab-${i}`, 0.12)),
        hours: round2(site.hours * k), ot_hours: round2(site.ot_hours * k), ot_dollars: round2(site.ot_dollars * k),
        budget_hours: round2(site.budget_hours * k), budget_dollars: round2(site.budget_dollars * k),
        prior_revenue: Math.round(site.prior_revenue * k), prior_labor: Math.round(site.prior_labor * k), prior_sub: Math.round(site.prior_sub * k),
        account_slug: spec.slug, company: spec.company, parent_account: spec.name,
      }
    }))
  return [...plano, ...others].map((r) => ({
    ...r,
    week_start: DEMO_LEADERSHIP_WEEK, week_end: addDays(DEMO_LEADERSHIP_WEEK, 6),
    needs_review: false, labor_basis: 'pay_report' as const, employees: Math.max(1, Math.round(r.hours / 30)), days_with_labor: r.hours > 0 ? 7 : 0,
    revenue_month: '2026-08-01', revenue_allocated: 0, revenue_month_basis: 'job_cost', invoice_week: null,
    prior_labor_basis: 'pay_report' as const, prior_sub_basis: r.prior_sub > 0 ? ('ap_distribution' as const) : ('job_cost' as const),
    delivery_model: 'self_perform' as const, sub_week: 0, sub_week_basis: null, consumables_cost: null, consumables_basis: null,
    latitude: 33.02 + jitter(`${r.job_number}-lat`, 0.004) - 1, longitude: -96.72 + jitter(`${r.job_number}-lon`, 0.004) - 1,
    city: 'Plano', state_province: 'TX',
  }))
}

/** A week's rows: the reference week as-is, earlier weeks scaled per job so trends move. */
function rowsForWeek(week: string): LeadershipRow[] {
  const base = baseRows()
  if (week === DEMO_LEADERSHIP_WEEK) return base
  return base.map((r) => {
    const k = jitter(`${r.account_slug}-${r.job_number}-${week}`, 0.09)
    return {
      ...r, week_start: week, week_end: addDays(week, 6),
      labor: round2(r.labor * k), hours: round2(r.hours * k), ot_hours: round2(r.ot_hours * k * jitter(`ot-${week}`, 0.2)), ot_dollars: round2(r.ot_dollars * k),
    }
  })
}

function demoAccounts(): LeadershipAccount[] {
  const rows = baseRows()
  return SPECS.map((s) => ({
    slug: s.slug, name: s.name, featured: true, sort: s.sort, target_labor_pct: s.target ?? 0.645, watch_band: 0.1,
    revenue_method: 'monthly_div', revenue_divisor: 4.33, budget_reliability_ratio: 0.8, source_parent_accounts: [s.name],
    segment_source: 'explicit', fallback_segment: s.fallback, revenue_allocation: 'none', cost_basis: ['amazon', 'fedex', 'whole-foods'].includes(s.slug) ? 'labor_plus_vendor' : 'labor', segments: s.segments.map((name, i) => ({ name, sort: i + 1, target_labor_pct: null })),
    sites: rows.filter((r) => r.account_slug === s.slug).length, needs_review: 0, updated_at: '2026-09-21T06:00:00Z', updated_by: 'demo',
  }))
}

export function demoLeadershipConfig(): LeadershipConfig {
  const weeks: LeadershipWeek[] = demoWeeks().map((w) => ({ week_start: w, week_end: addDays(w, 6), days_with_labor: 7, pay_report_share: 1, revenue_month: '2026-08-01', in_progress: false }))
  return {
    source, accounts: demoAccounts(), weeks, default_week: DEMO_LEADERSHIP_WEEK,
    status: { rebuilt_at: '2026-09-21T06:00:00Z', leadership_rebuilt_at: '2026-09-21T06:00:00Z', syncs: [], imports: {}, pay_report_through: [] },
  }
}

const mondayOf = (value: string) => { const d = new Date(`${value.slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return iso(d) }

export function demoLeadershipRows(query: LeadershipRowsQuery = {}): LeadershipRowsResponse {
  const anchor = query.week ? mondayOf(query.week) : DEMO_LEADERSHIP_WEEK
  const count = Math.max(1, Math.min(query.weeks ?? 1, 26))
  const weeks = Array.from({ length: count }, (_, i) => addDays(anchor, (i - count + 1) * 7)).filter((w) => demoWeeks().includes(w))
  const account = query.account ?? 'featured'
  const rows = weeks.flatMap(rowsForWeek).filter((r) => account === 'all' || account === 'featured' ? true : account === 'other' ? false : r.account_slug === account)
  return { source, week: anchor, weeks, account, rows }
}

export function demoLeadershipSite(company: string, jobNumber: string, query: { week?: string; weeks?: number } = {}): LeadershipSiteResponse {
  const weeks = demoLeadershipRows({ week: query.week, weeks: query.weeks ?? 13, account: 'all' }).rows.filter((r) => r.job_number === jobNumber && r.company === company)
  const last = weeks[weeks.length - 1]
  return {
    source,
    site: {
      company, job_number: jobNumber, site_name: last?.site_name ?? jobNumber, address_line_1: null, city: last?.city ?? null, state_province: last?.state_province ?? null,
      postal_code: null, latitude: last?.latitude ?? null, longitude: last?.longitude ?? null, parent_job_number: null, delivery_model: 'self_perform',
      parent_account: last?.parent_account ?? null, account_slug: last?.account_slug ?? null, segment: last?.segment ?? null, role: last?.role ?? 'site', companycam_project_id: null,
    },
    weeks,
    invoices: { since: '2026-04-01', vendor_type_ids: ['6'], total: last?.prior_sub ?? 0, lines: last && last.prior_sub > 0 ? [{ invoice_number: 'DEMO-1', invoice_date: '2026-08-31', gl_account_number: '44000', amount: last.prior_sub, vendor_number: 1, vendor_name: 'Demo subcontractor', vendor_type_id: 6 }] : [] },
    photos: { configured: false, project_id: null, items: null, error: null },
  }
}

export function demoLeadershipVendors(account: string): LeadershipVendorsResponse {
  const rows = baseRows().filter((r) => r.account_slug === account && r.prior_sub > 0)
  const lines = rows.map((r, i) => ({ invoice_number: `DEMO-${i + 1}`, invoice_date: '2026-08-31', gl_account_number: '44000', amount: r.prior_sub, vendor_number: 1 + (i % 2), vendor_name: i % 2 ? 'Demo floor care' : 'Demo subcontractor', vendor_type_id: 6, company: r.company ?? '', job_number: r.job_number, site_name: r.site_name }))
  const total = lines.reduce((a, l) => a + l.amount, 0)
  const byVendor = [1, 2].map((n) => ({ vendor_number: n, vendor_name: n === 2 ? 'Demo floor care' : 'Demo subcontractor', amount: lines.filter((l) => l.vendor_number === n).reduce((a, l) => a + l.amount, 0), invoices: lines.filter((l) => l.vendor_number === n).length })).filter((v) => v.invoices)
  return { account, since: '2026-04-01', vendor_type_ids: ['6'], total, by_vendor: byVendor,
    by_site: lines.map((l) => ({ company: l.company, job_number: l.job_number, site_name: l.site_name, amount: l.amount, invoices: 1 })),
    by_month: lines.length ? [{ month: '2026-08-01', amount: total, invoices: lines.length }] : [], lines }
}

/**
 * Demo staffing requests for a site: deterministic per job, a posted night line and, on every third
 * site, a submitted day line. Days open are counted to the end of the requested week.
 */
export function demoStaffingJob(company: string, jobNumber: string, query: { week?: string } = {}): StaffingJobResponse {
  const week = query.week ? mondayOf(query.week) : DEMO_LEADERSHIP_WEEK
  const weekEnd = addDays(week, 7)
  const k = jitter(`${company}-${jobNumber}-staffing`, 0.5)
  const days = (from: string) => Math.max(0, Math.round((Date.parse(`${weekEnd}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000))
  const line = (n: number, status: StaffingRequestLine['status'], shift: string, role: string, needed: number, submitted: string, rate: number): StaffingRequestLine => ({
    line_id: `demo-${jobNumber}-${n}`, request_id: `demo-${jobNumber}`, request_code: `SR-${jobNumber}`, site_name: null, role, shift,
    shift_start: shift === 'night' ? '22:00' : '06:00', shift_end: shift === 'night' ? '06:30' : '14:30', headcount_needed: needed, current_filled: null,
    reason: 'backfill', employment_type: 'full_time', hours_per_week: 40, pay_rate: rate, needed_by: addDays(week, 14), status, hire_job_id: status === 'posted' ? 'H-DEMO' : null,
    reported_headcount: null, submitted_at: `${submitted}T14:00:00Z`, decided_at: status === 'submitted' ? null : `${addDays(submitted, 1)}T14:00:00Z`,
    posted_at: status === 'posted' ? `${addDays(submitted, 2)}T14:00:00Z` : null, filled_at: null, closed_at: null, updated_at: `${submitted}T14:00:00Z`,
    days_open: days(submitted),
  })
  const lines = [line(1, 'posted', 'night', 'Custodian', Math.max(1, Math.round(2 * k)), addDays(week, -9), round2(15 * k))]
  if (Number(jobNumber.replace(/\D/g, '') || 0) % 3 === 0) lines.unshift(line(2, 'submitted', 'day', 'Porter', 1, addDays(week, 2), 15.5))
  const sum = (status: string) => lines.filter((l) => l.status === status).reduce((a, l) => a + l.headcount_needed, 0)
  return { source, configured: true, as_of: '2026-09-21T06:00:00Z', week, requested_headcount: sum('posted'), pending_requested_headcount: sum('submitted'), lines }
}
