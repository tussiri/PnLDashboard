import { describe, expect, it } from 'vitest'
import fixture from './fixtures/plano-we-2026-09-20.json'
import { hours, hours1, money, moneyK, pct, pts, rate } from './format'
import { accountSummary, baseRateOf, invoiceOf, siteMetrics, statusOf, type MetricOptions, type WeekRow } from './metrics'

// Expected values were produced by running the reference dashboard's own script on its embedded data.
const rows = fixture.rows as WeekRow[]
const exp = fixture.expected
const opts: MetricOptions = { target: fixture.target, divisor: fixture.divisor, revenueMethod: 'monthly_div' }
const summary = accountSummary(rows, opts, fixture.segments)
const job = (n: string) => summary.sites.find((r) => r.job_number === n)!

describe('leadership metrics against the Plano reference, week ending 2026-09-20', () => {
  it('reproduces the header KPIs', () => {
    expect(rows).toHaveLength(86)
    expect(summary.all.invoice).toBeCloseTo(exp.weeklyInvoice, 6)
    expect(summary.account.labor).toBeCloseTo(exp.accountLabor, 6)
    expect(summary.account.laborPct!).toBeCloseTo(exp.accountLp, 10)
    expect(summary.billed.laborPct!).toBeCloseTo(exp.sitesLp, 10)
    expect(summary.all.laborPct!).toBeCloseTo(exp.allInLp, 10)
    expect(summary.account.hours).toBeCloseTo(exp.hours, 6)
    expect(summary.account.otHours).toBeCloseTo(exp.otHours, 6)
    expect(summary.account.otPct).toBeCloseTo(exp.otPct, 10)
    expect(summary.billed.over).toBe(exp.sitesOver)
    expect(summary.billed.overHours).toBeCloseTo(exp.sitesOverHours, 6)
    expect(summary.catchAllOverHours).toBeCloseTo(exp.catchAllHours, 6)
    expect(summary.headerOverHours).toBeCloseTo(exp.headerOverHours, 6)
  })

  it('reproduces the per-site formulas', () => {
    for (const [n, e] of Object.entries(exp.byJob)) {
      const r = job(n)
      expect(r.invoice).toBeCloseTo(e.inv, 8)
      if (e.lp == null) expect(r.laborPct).toBeNull()
      else expect(r.laborPct!).toBeCloseTo(e.lp, 10)
      expect(r.baseRate).toBeCloseTo(e.baseRate, 10)
      expect(r.overDollars).toBeCloseTo(e.overDol, 8)
      expect(r.overHours).toBeCloseTo(e.overHrs, 8)
      expect(r.otPct).toBeCloseTo(e.otPct, 10)
    }
    expect(invoiceOf(rows[1], opts)).toBeCloseTo(12642 / 4.33, 10)
    expect(baseRateOf(2431.26, 140.43, 12.26)).toBeCloseTo(2431.26 / (140.43 + 6.13), 10)
  })

  it('reproduces the segment rollups', () => {
    expect(summary.segments.map((s) => s.segment)).toEqual(fixture.segments)
    for (const s of summary.segments) {
      const e = exp.segments[s.segment as keyof typeof exp.segments]
      expect(s.rollup.count).toBe(e.n)
      expect(s.rollup.invoice).toBeCloseTo(e.inv, 6)
      expect(s.rollup.labor).toBeCloseTo(e.lab, 6)
      expect(s.rollup.laborPct!).toBeCloseTo(e.lp, 10)
      expect(s.rollup.over).toBe(e.over)
      expect(s.rollup.otPct).toBeCloseTo(e.otPct, 10)
    }
  })

  it('reproduces the Over Target tab', () => {
    const t = summary.overTarget
    expect(t.rows).toHaveLength(exp.overTab.locations)
    expect(t.billedCount).toBe(exp.overTab.billed)
    expect(t.rollup.overHours).toBeCloseTo(exp.overTab.hours, 6)
    expect(t.rollup.overDollars).toBeCloseTo(exp.overTab.dollars, 6)
    expect(t.fromOtPremium).toBeCloseTo(exp.overTab.otPremiumHours, 6)
    expect(t.fromExtraHours).toBeCloseTo(exp.overTab.hours - exp.overTab.otPremiumHours, 6)
  })

  it('reproduces the Overtime tab', () => {
    const o = summary.overtime
    expect(o.hours).toBeCloseTo(exp.ot.hours, 6)
    expect(o.dollars).toBeCloseTo(exp.ot.dollars, 6)
    expect(o.premiumDollars).toBeCloseTo(exp.ot.premium, 6)
    expect(o.rowsWithOt).toBe(exp.ot.withOt)
    expect(o.rowsWithLabor).toBe(exp.ot.withLabor)
  })

  it('raises the reference notes from data, not job numbers', () => {
    const kinds = summary.notes.map((n) => n.kind)
    expect(kinds).toEqual(['catch_all', 'non_billed', 'billed_no_labor', 'budget_unreliable'])
    const noLabor = summary.notes.find((n) => n.kind === 'billed_no_labor')
    expect(noLabor && noLabor.kind === 'billed_no_labor' && noLabor.jobs.map((j) => j.job_number)).toEqual(exp.billedNoLabor)
    const budget = summary.notes.find((n) => n.kind === 'budget_unreliable')
    expect(budget && budget.kind === 'budget_unreliable' && budget.ratio).toBeCloseTo(exp.budgetRatio, 10)
  })

  it('computes prior-month labor % including subcontractor cost', () => {
    // Decision 2026-09-23: (labor + sub) ÷ revenue. The reference drew labor ÷ revenue.
    expect(job('853').priorLaborPct!).toBeCloseTo((39729 + 14132) / 56129, 10)
    expect(job('801').priorLaborPct!).toBeCloseTo(8791 / 12642, 10)
    expect(job('800').priorLaborPct).toBeNull()
  })

  it('classifies status with the reference thresholds', () => {
    expect(statusOf(0.645, 0.645)).toBe('on_target')
    expect(statusOf(0.7449, 0.645)).toBe('watch')
    expect(statusOf(0.746, 0.645)).toBe('over')
    expect(statusOf(null, 0.645)).toBe('no_billing')
  })

  it('recomputes when the target changes', () => {
    const lower = accountSummary(rows, { ...opts, target: 0.6 }, fixture.segments)
    expect(lower.billed.overHours).toBeGreaterThan(summary.billed.overHours)
    expect(lower.catchAllOverHours).toBeCloseTo(summary.catchAllOverHours, 10)
  })

  it('uses the billed amount for weekly-billing accounts', () => {
    const r = siteMetrics({ ...rows[1], invoice_week: 3000 }, { target: 0.6, revenueMethod: 'weekly_billing' })
    expect(r.invoice).toBe(3000)
    expect(r.laborPct!).toBeCloseTo(2431.26 / 3000, 10)
  })

  it('flags estimated labor when a row is not from the pay report', () => {
    const s = accountSummary([{ ...rows[1], labor_basis: 'trailing_rate_estimate' }, { ...rows[2], labor_basis: 'pay_report' }], opts)
    expect(s.notes.find((n) => n.kind === 'labor_estimated')).toEqual({ kind: 'labor_estimated', jobs: 1, labor: rows[1].labor })
  })
})

describe('cost basis, segment targets and allocation', () => {
  const base = { ...rows[1], sub_week: 1000 } // Academy HS: invoice 12642 / 4.33, labor 2431.26
  it('ignores vendor cost under the labor basis and counts it under labor_plus_vendor', () => {
    const labor = siteMetrics(base, opts)
    expect(labor.measurePct).toBeCloseTo(labor.laborPct!, 12)
    expect(labor.cost).toBe(2431.26)
    const cost = siteMetrics(base, { ...opts, costBasis: 'labor_plus_vendor' })
    expect(cost.cost).toBeCloseTo(3431.26, 8)
    expect(cost.measurePct!).toBeCloseTo(3431.26 / (12642 / 4.33), 10)
    expect(cost.laborPct!).toBeCloseTo(labor.laborPct!, 12)
    expect(cost.overDollars).toBeCloseTo(3431.26 - (12642 / 4.33) * 0.645, 8)
    expect(cost.status).toBe('over')
  })

  it('judges a fully subcontracted site by $ over target with no hours over', () => {
    const sub = siteMetrics({ ...base, labor: 0, hours: 0, ot_hours: 0, ot_dollars: 0, sub_week: 2500 }, { ...opts, costBasis: 'labor_plus_vendor' })
    expect(sub.overDollars).toBeCloseTo(2500 - (12642 / 4.33) * 0.645, 8)
    expect(sub.overHours).toBe(0)
  })

  it('applies a segment target override to sites and segment rollups', () => {
    const s = accountSummary(rows, { ...opts, segmentTargets: { 'High School': 0.7 } }, fixture.segments)
    const hs = s.segments.find((x) => x.segment === 'High School')!
    expect(hs.target).toBe(0.7)
    expect(job('801').target).toBe(0.645)
    expect(s.sites.find((r) => r.job_number === '801')!.target).toBe(0.7)
    expect(hs.rollup.over).toBeLessThan(exp.segments['High School'].over)
  })

  it('does not list a subcontracted site with vendor cost as billed without labor', () => {
    const s = accountSummary([{ ...rows[1], labor: 0, hours: 0, ot_hours: 0, sub_week: 900 }, { ...rows[2], labor: 0, hours: 0, ot_hours: 0 }], opts)
    const note = s.notes.find((n) => n.kind === 'billed_no_labor')
    expect(note && note.kind === 'billed_no_labor' && note.jobs.map((j) => j.job_number)).toEqual([rows[2].job_number])
  })

  it('counts estimated labor only where there is labor', () => {
    const s = accountSummary([{ ...rows[1], labor_basis: 'trailing_rate_estimate' }, { ...rows[2], labor: 0, labor_basis: 'trailing_rate_estimate' }], opts)
    expect(s.notes.find((n) => n.kind === 'labor_estimated')).toEqual({ kind: 'labor_estimated', jobs: 1, labor: rows[1].labor })
  })

  it('notes projected vendor cost for cost-% accounts only', () => {
    const r = [{ ...rows[1], sub_week: 500, sub_week_basis: 'prior_month_prorated' }, { ...rows[2], sub_week: 200, sub_week_basis: 'job_cost_month_prorated' }]
    expect(accountSummary(r, { ...opts, costBasis: 'labor_plus_vendor' }).notes.find((n) => n.kind === 'vendor_projected')).toEqual({ kind: 'vendor_projected', jobs: 1, amount: 500 })
    expect(accountSummary(r, opts).notes.find((n) => n.kind === 'vendor_projected')).toBeUndefined()
  })

  it('notes revenue allocated from a parent job', () => {
    const s = accountSummary([{ ...rows[1], revenue_allocated: 400 }, { ...rows[2], revenue_allocated: 0 }], opts)
    expect(s.notes.find((n) => n.kind === 'revenue_allocated')).toEqual({ kind: 'revenue_allocated', jobs: 1, amount: 400 })
  })
})

describe('leadership formats', () => {
  it('matches the reference formatters', () => {
    expect(money(1234.6)).toBe('$1,235')
    expect(money(-1234.6)).toBe('($1,235)')
    expect(money(null)).toBe('–')
    expect(moneyK(84465.8)).toBe('$84.5K')
    expect(moneyK(237172)).toBe('$237K')
    expect(hours(1951.64)).toBe('1,952')
    expect(hours1(140.43)).toBe('140.4')
    expect(pct(0.93275)).toBe('93.3%')
    expect(pct(null)).toBe('–')
    expect(pts(-0.024)).toBe('−2.4 pts')
    expect(rate(16.6)).toBe('$16.60')
  })
})
