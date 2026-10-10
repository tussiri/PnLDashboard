import { describe, expect, it } from 'vitest'
import type { BudgetMonth, CompanyMonth } from '../services/apiTypes'
import { accountsStory, allocationsStory, largestRemainder, per100, planStory, revenueStory, storyWindow, weekStory, yearWindow } from './storyMetrics'

const money = { revenue: 0, direct_labor: 0, management_wages: 0, subcontractors: 0, payroll_taxes: 0, gross_profit: 0 }
function month(m: string, v: Partial<CompanyMonth> = {}): CompanyMonth {
  return {
    ...money, month: `${m}-01`, closed: true, timekeeping_labor: 0, unbilled_cost: 0, by_company: {}, by_account: {}, statement: {},
    allocations: { management_wages: 0, burden: 0, overhead: 0, burden_rate: null, burden_source: null, overhead_source: null }, flags: [], ...v,
  }
}
const series = (n: number, v: (i: number) => Partial<CompanyMonth>) =>
  Array.from({ length: n }, (_, i) => month(`2026-${String(i + 1).padStart(2, '0')}`, v(i)))

describe('largestRemainder', () => {
  it('always sums to the total', () => {
    expect(largestRemainder([1, 1, 1])).toEqual([34, 33, 33])
    expect(largestRemainder([62.4, 20.3, 9.6, 2.9, 4.8]).reduce((a, b) => a + b)).toBe(100)
    expect(largestRemainder([0.5, 0.5])).toEqual([50, 50])
  })
  it('gives the extra squares to the largest remainders', () => {
    expect(largestRemainder([60.6, 20.6, 18.8])).toEqual([61, 20, 19])
  })
  it('draws nothing for an empty or negative split', () => {
    expect(largestRemainder([0, 0])).toEqual([0, 0])
    expect(largestRemainder([120, -20])).toEqual([0, 0])
  })
})

describe('storyWindow and revenueStory', () => {
  it('anchors to the last month in the data and counts only closed months', () => {
    const months = series(9, (i) => ({ revenue: 100, gross_profit: 20, direct_labor: 60, closed: i < 8 }))
    const w = storyWindow([month('2025-06', { revenue: 999 }), ...months], 9)
    expect(w.from).toBe('2026-01-01')
    expect(w.through).toBe('2026-09-01')
    const r = revenueStory(w)
    expect(r.revenue).toBe(800)
    expect(r.closedMonths).toBe(8)
    expect(r.margin).toBeCloseTo(0.2)
    expect(r.laborPct).toBeCloseTo(0.6)
    expect(r.openMonths).toEqual(['2026-09-01'])
  })
  it('reconciles the 12 months with the calendar year to date', () => {
    const r = revenueStory(storyWindow([month('2025-11', { revenue: 50 }), month('2025-12', { revenue: 70 }), month('2026-01', { revenue: 100 }), month('2026-02', { revenue: 110 })]))
    expect(r.revenue).toBe(330)
    expect(r.yearToDate).toEqual({ year: '2026', revenue: 210 })
  })
  it('compares the latest three closed months with the three before', () => {
    const r = revenueStory(storyWindow(series(6, (i) => ({ revenue: i < 3 ? 100 : 110 }))))
    expect(r.trend?.prior).toBe(300)
    expect(r.trend?.recent).toBe(330)
    expect(r.trend?.change).toBeCloseTo(0.1)
  })
  it('leaves what is not yet knowable null', () => {
    const r = revenueStory(storyWindow(series(4, () => ({ revenue: 100, closed: false }))))
    expect(r.revenue).toBeNull()
    expect(r.margin).toBeNull()
    expect(r.trend).toBeNull()
  })
})

describe('yearWindow', () => {
  it('keeps the months of the latest closed month\'s year, as the Company year to date does', () => {
    const w = storyWindow([month('2025-11', { revenue: 50 }), month('2025-12', { revenue: 50 }), month('2026-01', { revenue: 100 }), month('2026-02', { revenue: 120, closed: false })])
    const y = yearWindow(w)!
    expect([y.from, y.through]).toEqual(['2026-01-01', '2026-02-01'])
    expect(revenueStory(y).revenue).toBe(100)
    expect(revenueStory(y).revenue).toBe(revenueStory(w).yearToDate?.revenue)
  })
  it('is null with no closed month', () => {
    expect(yearWindow(storyWindow([month('2026-01', { revenue: 100, closed: false })]))).toBeNull()
  })
})

describe('per100', () => {
  it('splits revenue into 100 squares, other job cost as the reconciling line', () => {
    const p = per100([month('2026-01', { revenue: 1000, direct_labor: 600, subcontractors: 100, payroll_taxes: 80, gross_profit: 170 })])!
    expect(p.parts.map((x) => [x.key, x.squares])).toEqual([['labor', 60], ['subcontractors', 10], ['taxes', 8], ['other', 5], ['profit', 17]])
    expect(p.parts.reduce((a, x) => a + x.squares, 0)).toBe(100)
  })
  it('leaves off other job cost that is only cents', () => {
    const p = per100([month('2026-01', { revenue: 1000.4, direct_labor: 700, gross_profit: 300 })])!
    expect(p.parts.map((x) => x.key)).toEqual(['labor', 'profit'])
  })
  it('reads rounding in other job cost as zero and leaves zero lines off the squares', () => {
    const p = per100([month('2026-01', { revenue: 1000, direct_labor: 700, gross_profit: 302 })])!
    expect(p.parts.map((x) => x.key)).toEqual(['labor', 'profit'])
    expect(p.parts.reduce((a, x) => a + x.squares, 0)).toBe(100)
    expect(p.missing).toEqual(['Subcontractors', 'Payroll taxes and insurance'])
  })
  it('is not drawn for a gross loss or costs that do not reconcile', () => {
    expect(per100([month('2026-01', { revenue: 100, direct_labor: 120, gross_profit: -20 })])).toBeNull()
    expect(per100([month('2026-01', { revenue: 100, direct_labor: 50, gross_profit: 80 })])).toBeNull()
    expect(per100([])).toBeNull()
  })
})

describe('accountsStory', () => {
  it('ranks accounts by revenue with Other last', () => {
    const m = month('2026-01', { by_account: {
      other: { ...money, revenue: 900, gross_profit: 90 }, a: { ...money, revenue: 300, gross_profit: -10 }, b: { ...money, revenue: 800, gross_profit: 200 },
      c: { ...money, revenue: 0 } } })
    const s = accountsStory([m, m], { a: 'Alpha', b: 'Beta' })
    expect(s.rows.map((r) => r.name)).toEqual(['Beta', 'Alpha', 'Other accounts'])
    expect(s.revenue).toBe(4000)
    expect(s.top?.share).toBeCloseTo(0.4)
    expect(s.losingRecently).toBe(1)
  })
  it('flags an account that is profitable over the year but losing money in the latest months', () => {
    const acct = (revenue: number, gross_profit: number) => ({ by_account: { f: { ...money, revenue, gross_profit } } })
    const months = [...series(9, () => acct(100, 20)), ...series(3, () => acct(100, -10)).map((m, i) => ({ ...m, month: `2026-1${i}-01` }))]
    const s = accountsStory(months, { f: 'FedEx' })
    expect(s.rows[0].margin).toBeCloseTo(150 / 1200)
    expect(s.rows[0].recentMargin).toBeCloseTo(-0.1)
    expect(s.losingRecently).toBe(1)
    expect(s.recentFrom).toBe('2026-10-01')
  })
})

describe('weekStory', () => {
  it('counts accounts by status, worst against target first, and leaves out accounts without billing', () => {
    const s = weekStory([
      { slug: 'a', name: 'A', laborPct: 0.6, target: 0.65, overHours: 0 },
      { slug: 'b', name: 'B', laborPct: 0.9, target: 0.65, overHours: 120 },
      { slug: 'c', name: 'C', laborPct: 0.7, target: 0.65, overHours: 30 },
      { slug: 'd', name: 'D', laborPct: null, target: 0.65, overHours: null },
    ])
    expect(s.rows.map((r) => r.slug)).toEqual(['b', 'c', 'a'])
    expect([s.over, s.watch, s.onTarget, s.noData]).toEqual([1, 1, 1, 1])
    expect(s.overHours).toBe(150)
  })
  it('has no hours figure when no account was rated', () => {
    expect(weekStory([{ slug: 'd', name: 'D', laborPct: null, target: 0.65, overHours: null }]).overHours).toBeNull()
  })
})

describe('planStory', () => {
  const b = (m: string, budget: number, actual: number | null, inProgress = false): BudgetMonth => ({
    month: `${m}-01`, in_progress: inProgress, details: {}, supplies: null,
    budget: { site: budget, overhead: 0, total: budget, revenue: null, labor_pct: null },
    actual: actual == null ? null : { site: actual, overhead: 0, events: 0, total: actual, revenue: 0, basis: 'job_cost', labor_pct: null },
    variance: null,
  })
  const window = ['2026-01-01', '2026-02-01', '2026-03-01']
  it('sums budget and actual over accounts with both, finished months in the window only', () => {
    const s = planStory([
      { slug: 'a', months: [b('2026-01', 100, 110), b('2026-02', 100, 90), b('2026-03', 100, 50, true), b('2025-12', 100, 100)] },
      { slug: 'b', months: [b('2026-01', 50, null), b('2026-02', 50, 60)] },
    ], window)!
    expect(s.months.map((m) => [m.month, m.budget, m.actual, m.accounts])).toEqual([['2026-01-01', 100, 110, 1], ['2026-02-01', 150, 150, 2]])
    expect(s.accounts).toBe(2)
    expect(s.variancePct).toBeCloseTo(260 / 250 - 1)
  })
  it('is null with fewer than two comparable months', () => {
    expect(planStory([{ slug: 'a', months: [b('2026-01', 100, 110)] }], window)).toBeNull()
    expect(planStory([], window)).toBeNull()
  })
})

describe('allocationsStory', () => {
  it('takes allocations off gross profit', () => {
    const alloc = { management_wages: 10, burden: 5, overhead: 15, burden_rate: null, burden_source: null, overhead_source: null }
    const s = allocationsStory([month('2026-01', { revenue: 200, gross_profit: 50, allocations: alloc })])!
    expect(s.after).toBe(20)
    expect(s.share).toBeCloseTo(0.1)
  })
  it('is null when nothing is allocated', () => {
    expect(allocationsStory([month('2026-01', { revenue: 200, gross_profit: 50 })])).toBeNull()
  })
})

describe('compact', () => {
  it('writes negatives in parentheses and zero plainly', async () => {
    const { compact } = await import('./CompanyStory')
    expect(compact(0)).toBe('$0')
    expect(compact(-1_000_000)).toBe('($1.0M)')
    expect(compact(-506_731)).toBe('($507K)')
    expect(compact(34_400_000)).toBe('$34.4M')
  })
})
