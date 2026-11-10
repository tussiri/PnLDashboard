/**
 * Demo company P&L (GET /leadership/company-pl) for the month-end view: synthetic customers built month by
 * month with the same overhead rule as app/company_pl.py (fixed charge, direct staff, then the pool by
 * revenue), so the groups, customers and companies add up to net profit. Shown only in demo mode.
 */
import type { CompanyPlAppliedAdjustment, CompanyPlCompany, CompanyPlCustomer, CompanyPlGroup, CompanyPlMonth, CompanyPlResponse, CompanyPlSettings, PlCategory } from './apiTypes'

type Lines = Record<PlCategory, number>
interface Spec { name: string; group: string; account?: string; company: string; jobs: number; revenue: number; labor: number; sub: number; supplies: number; opex: number; growth: number }

const SETTINGS: CompanyPlSettings = {
  overhead_jobs: ['6325', '63252', '63253'],
  groups: [
    { key: 'fedex_subs', name: 'New FedEx subs', accounts: ['fedex'], delivery_model: 'subcontracted', fixed_monthly: 30000, shares_pool: false, rest: false },
    { key: 'education', name: 'Education', accounts: ['plano-isd', 'white-settlement-isd', 'henderson-isd'], delivery_model: null, fixed_monthly: 0, shares_pool: true, rest: false },
    { key: 'core', name: 'Amazon + other customers', accounts: [], delivery_model: null, fixed_monthly: 0, shares_pool: true, rest: true },
  ],
  pool_basis: 'revenue',
  gl_categories: [],
}

// Shares of revenue: labor, subcontractors, supplies, operating expenses on the jobs.
const SPECS: Spec[] = [
  { name: 'Amazon', group: 'core', account: 'amazon', company: 'Crane IFS', jobs: 20, revenue: 2_450_000, labor: 0.62, sub: 0.02, supplies: 0.03, opex: 0.01, growth: 0.012 },
  { name: 'FedEx', group: 'fedex_subs', account: 'fedex', company: 'Crane IFS', jobs: 62, revenue: 1_850_000, labor: 0.04, sub: 0.86, supplies: 0.01, opex: 0.004, growth: 0.06 },
  { name: 'Plano ISD', group: 'education', account: 'plano-isd', company: 'Crane IFS', jobs: 70, revenue: 610_000, labor: 0.71, sub: 0, supplies: 0.04, opex: 0.01, growth: 0.004 },
  { name: 'White Settlement ISD', group: 'education', account: 'white-settlement-isd', company: 'Crane IFS', jobs: 16, revenue: 154_000, labor: 0.68, sub: 0, supplies: 0.05, opex: 0.01, growth: 0 },
  { name: 'Henderson ISD', group: 'education', account: 'henderson-isd', company: 'Crane IFS', jobs: 11, revenue: 118_000, labor: 0.83, sub: 0, supplies: 0.05, opex: 0.01, growth: 0 },
  { name: 'Whole Foods', group: 'core', account: 'whole-foods', company: 'Crane IFS', jobs: 12, revenue: 236_000, labor: 0.64, sub: 0.05, supplies: 0.05, opex: 0.01, growth: 0.005 },
  { name: 'Aldi', group: 'core', account: 'aldi', company: 'Crane IFS', jobs: 2, revenue: 61_000, labor: 0.58, sub: 0.1, supplies: 0.04, opex: 0.01, growth: 0 },
  { name: 'Apple / Retail', group: 'core', account: 'apple-retail', company: 'Crane IFS', jobs: 40, revenue: 330_000, labor: 0.55, sub: 0.18, supplies: 0.03, opex: 0.01, growth: 0.01 },
  { name: 'CoreSite Real Estate', group: 'core', company: 'Crane IFS', jobs: 3, revenue: 92_000, labor: 0.6, sub: 0, supplies: 0.04, opex: 0.01, growth: 0 },
  { name: 'Costco Regional', group: 'core', company: 'Crane IFS', jobs: 1, revenue: 48_000, labor: 0.86, sub: 0.07, supplies: 0.05, opex: 0.01, growth: 0 },
  { name: 'Akrometrix', group: 'core', company: 'Crane IFS', jobs: 2, revenue: 22_000, labor: 0.66, sub: 0, supplies: 0.03, opex: 0, growth: 0 },
  { name: 'Tesla', group: 'core', company: 'Sarus', jobs: 4, revenue: 230_000, labor: 0.72, sub: 0, supplies: 0.02, opex: 0.02, growth: -0.04 },
  { name: 'Fuyao Glass America', group: 'core', company: 'Sarus', jobs: 2, revenue: 310_000, labor: 0.64, sub: 0, supplies: 0.02, opex: 0.01, growth: 0.01 },
  { name: 'Benchmark Technology', group: 'core', company: 'Sarus', jobs: 1, revenue: 76_000, labor: 0.69, sub: 0, supplies: 0.02, opex: 0.01, growth: 0 },
]

const zero = (): Lines => ({ revenue: 0, direct_labor: 0, payroll_taxes_insurance: 0, subcontractors: 0, supplies: 0, other_direct: 0, operating_expense: 0 })
const r2 = (v: number) => Math.round(v * 100) / 100
const plOf = (l: Lines) => {
  const direct = l.direct_labor + l.payroll_taxes_insurance + l.subcontractors + l.supplies + l.other_direct
  const gp = l.revenue - direct
  return { ...Object.fromEntries(Object.entries(l).map(([k, v]) => [k, r2(v)])) as Lines, direct_costs: r2(direct), gross_profit: r2(gp), before_overhead: r2(gp - l.operating_expense) }
}
const add = (a: Lines, b: Lines) => { for (const k of Object.keys(a) as PlCategory[]) a[k] += b[k] }

function month(i: number, iso: string, last: boolean): CompanyPlMonth {
  // A gentle seasonal wave and a summer dip for the schools.
  const wave = 1 + 0.03 * Math.sin(i * 1.3)
  const jobs = SPECS.map((s) => {
    const summer = s.group === 'education' && (i === 5 || i === 6) ? 0.55 : 1
    const rev = s.revenue * (1 + s.growth * i) * wave * summer
    const labor = rev * (s.labor + (s.group === 'education' && summer < 1 ? 0.12 : 0)) * (1 + 0.015 * Math.cos(i * 2.1))
    const lines: Lines = { revenue: rev, direct_labor: labor, payroll_taxes_insurance: labor * 0.115, subcontractors: rev * s.sub, supplies: rev * s.supplies, other_direct: rev * 0.004, operating_expense: rev * s.opex }
    return { spec: s, lines }
  })
  const adjustments: CompanyPlAppliedAdjustment[] = []
  if (last) {
    const fedex = jobs.find((j) => j.spec.name === 'FedEx')!
    const tesla = jobs.find((j) => j.spec.name === 'Tesla')!
    fedex.lines.revenue += 96_000
    tesla.lines.revenue += 85_500
    tesla.lines.direct_labor += 52_000
    adjustments.push(
      { adjustment_id: 101, kind: 'accrual', category: 'revenue', amount: 96_000, effect: 96_000, description: 'FedEx pallet billing, October pallet sheet', reversal: false, job: '246', groups: { fedex_subs: 96_000 }, revenue_effect: 96_000, cost_effect: 0, net_effect: 96_000 },
      { adjustment_id: 102, kind: 'accrual', category: 'revenue', amount: 85_500, effect: 85_500, description: 'Tesla October invoices awaiting approval', reversal: false, job: 'S1', groups: { core: 85_500 }, revenue_effect: 85_500, cost_effect: 0, net_effect: 85_500 },
      { adjustment_id: 103, kind: 'accrual', category: 'direct_labor', amount: 52_000, effect: 52_000, description: 'Tesla October labor, estimated', reversal: false, job: 'S1', groups: { core: -52_000 }, revenue_effect: 0, cost_effect: 52_000, net_effect: -52_000 },
    )
  }
  const overheadCost = 640_000 + 9_000 * i + (i === 2 ? -311_000 : 0)
  const interest = i < 4 ? 30_000 - 1_500 * i : 160_000 + 9_000 * (i - 4)
  const amortization = i < 4 ? 0 : 38_000 + 4_500 * (i - 4)
  const staff: Record<string, number> = { fedex_subs: i >= 5 ? 18_000 : 0, education: i >= 5 ? 14_000 : 0, core: i >= 5 ? 26_000 : 0 }
  const byGroup: Record<string, Lines> = Object.fromEntries(SETTINGS.groups.map((g) => [g.key, zero()]))
  for (const j of jobs) add(byGroup[j.spec.group], j.lines)
  const fixedTotal = SETTINGS.groups.reduce((a, g) => a + g.fixed_monthly, 0)
  const staffTotal = Object.values(staff).reduce((a, v) => a + v, 0)
  const pool = overheadCost - fixedTotal - staffTotal
  const shareBase = SETTINGS.groups.filter((g) => g.shares_pool).reduce((a, g) => a + byGroup[g.key].revenue, 0)
  const load: Record<string, number> = {}
  const groups: CompanyPlGroup[] = SETTINGS.groups.map((g) => {
    const p = plOf(byGroup[g.key])
    const poolCharge = g.shares_pool ? pool * byGroup[g.key].revenue / shareBase : 0
    load[g.key] = g.fixed_monthly + staff[g.key] + poolCharge
    const after = p.before_overhead - load[g.key]
    return { key: g.key, name: g.name, ...p, fixed_charge: g.fixed_monthly, direct_staff: staff[g.key], pool_charge: r2(poolCharge), pool_share: g.shares_pool ? r2(poolCharge / pool * 10000) / 10000 : null,
      overhead: r2(load[g.key]), after_overhead: r2(after), margin: p.revenue ? after / p.revenue : null }
  })
  const customers: CompanyPlCustomer[] = jobs.map(({ spec, lines }) => {
    const p = plOf(lines)
    const oh = load[spec.group] * lines.revenue / byGroup[spec.group].revenue
    return { name: spec.name, group: spec.group, jobs: Array.from({ length: spec.jobs }, (_, k) => String(100 + k)), revenue: p.revenue, gross_profit: p.gross_profit, before_overhead: p.before_overhead, overhead: r2(oh), after_overhead: r2(p.before_overhead - oh) }
  })
  const accounts: CompanyPlMonth['accounts'] = {}
  const other = zero()
  let otherOverhead = 0
  for (const j of jobs) {
    const oh = load[j.spec.group] * j.lines.revenue / byGroup[j.spec.group].revenue
    if (j.spec.account) { const p = plOf(j.lines); accounts[j.spec.account] = { name: j.spec.name, ...p, overhead: r2(oh), after_overhead: r2(p.before_overhead - oh) } }
    else { add(other, j.lines); otherOverhead += oh }
  }
  const op = plOf(other)
  accounts.other = { name: 'Other', ...op, overhead: r2(otherOverhead), after_overhead: r2(op.before_overhead - otherOverhead) }
  const companies: Record<string, CompanyPlCompany> = {}
  for (const name of ['Crane IFS', 'Sarus']) {
    const l = zero()
    for (const j of jobs) if (j.spec.company === name) add(l, j.lines)
    const p = plOf(l)
    const oh = name === 'Crane IFS' ? overheadCost : 0
    companies[name] = { ...p, overhead: oh, net_profit: r2(p.before_overhead - oh) }
  }
  const all = zero()
  for (const j of jobs) add(all, j.lines)
  const c = plOf(all)
  const net = c.before_overhead - overheadCost
  const ebitaGroups = Object.fromEntries(groups.map((g) => {
    const corporate = (interest + amortization) * load[g.key] / overheadCost
    return [g.key, { own: 0, corporate: r2(corporate), ebita: r2(g.after_overhead + corporate) }]
  }))
  return {
    month: iso,
    company: { revenue: c.revenue, operating_revenue: c.revenue, direct_labor: c.direct_labor, payroll_taxes_insurance: c.payroll_taxes_insurance, subcontractors: c.subcontractors, supplies: c.supplies,
      other_direct: c.other_direct, direct_costs: c.direct_costs, gross_profit: c.gross_profit, operating_expense: c.operating_expense, before_overhead: c.before_overhead, overhead: overheadCost,
      net_profit: r2(net), gross_margin: c.gross_profit / c.revenue, net_margin: net / c.revenue, overhead_pct: overheadCost / c.revenue },
    overhead: { cost: overheadCost, revenue_on_overhead_jobs: 0, fixed: fixedTotal, direct_staff: staffTotal, pool: r2(pool) },
    groups, accounts, customers, companies,
    ebita: { interest, amortization, income_tax: 0, depreciation: 4_200, addback: interest + amortization, corporate_addback: interest + amortization, ebita: r2(net + interest + amortization), groups: ebitaGroups },
    adjustments,
  }
}

/** January to October 2026; October carries Finance's accruals (pro forma). */
export function demoCompanyPl(): CompanyPlResponse {
  const isos = Array.from({ length: 10 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}-01`)
  return { settings: SETTINGS, months: isos.map((iso, i) => month(i, iso, i === isos.length - 1)), loaded: isos.map((iso) => ({ month: iso, loaded_at: '2026-11-09T14:00:00Z', companies: ['Crane IFS', 'Sarus'] })) }
}
