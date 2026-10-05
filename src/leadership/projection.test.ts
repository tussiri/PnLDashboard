import { describe, expect, it } from 'vitest'
import { projectRecentWeeks, type TrendWeek } from './projection'

const wk = (week: string, cost: number | null, invoice = 200, segs: Record<string, number | null> = { HS: cost == null ? null : cost / invoice }): TrendWeek =>
  ({ week, cost, invoice, lp: cost == null ? null : cost / invoice, sitesLp: cost == null ? null : cost / invoice, segs })

describe('trend projection', () => {
  const weeks = [wk('08-31', 100), wk('09-07', 120), wk('09-14', 140), wk('09-21', 160)]

  it('projects a latest week whose labor has not arrived from the four before it', () => {
    const out = projectRecentWeeks([...weeks, wk('09-28', 0)], new Set())
    expect(out.map((x) => x.projected)).toEqual([false, false, false, false, true])
    expect(out[4].cost).toBe(130)
    expect(out[4].lp).toBeCloseTo(0.65)
    expect(out[4].segs.HS).toBeCloseTo(0.65)
  })
  it('projects the week in progress even when part of its labor is in, never below what is in', () => {
    const out = projectRecentWeeks([...weeks, wk('09-28', 150)], new Set(['09-28']))
    expect(out[4].projected).toBe(true)
    expect(out[4].cost).toBe(150)
  })
  it('leaves complete weeks and older gaps alone', () => {
    const out = projectRecentWeeks([wk('08-24', 100), wk('08-31', 0), ...weeks.slice(1), wk('09-28', 150)], new Set())
    expect(out.every((x) => !x.projected)).toBe(true)
  })
})
