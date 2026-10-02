import { describe, expect, it } from 'vitest'
import { parseAmount, parseBudget, parseDay, parseMonth, splitTable } from './budgetParse'

// Plano ISD's 2026-27 plan as Excel copies it: tab-separated, wrapped headers quoted.
const PLANO = [
  'Month\t"School\ndays"\tStaff days\t"Closure\ndays"\t"Summer\ndays"\t"Stat\nholidays"\tSite labor\tOverhead labor\tTotal labor\tRevenue\tLabor %\t"Supplies, consumables &\nequipment"',
  'Jul 2026\t0\t0\t0\t22\t1\t$293,962\t$44,061\t$338,023\t$1,026,956\t32.9%\t$125,000',
  'Aug 2026\t15\t0\t0\t6\t0\t$653,907\t$40,230\t$694,137\t$1,026,956\t67.6%\t$125,000',
  'Sep 2026\t21\t0\t0\t0\t1\t$854,454\t$42,146\t$896,599\t$1,026,956\t87.3%\t$125,000',
  'Jun 2027\t0\t0\t1\t21\t0\t$245,215\t$42,146\t$287,361\t$1,026,956\t28.0%\t$125,000',
  'Year\t171\t7\t22\t54\t7\t$7,818,344\t$500,000\t$8,318,344\t$12,323,472\t67.5%\t$1,500,000',
].join('\n')

describe('parseBudget', () => {
  it('reads the pasted Plano plan, skipping the Year row', () => {
    const p = parseBudget(PLANO)
    expect(p.errors).toEqual([])
    expect(p.skipped).toEqual(['Year'])
    expect(p.rows.map((r) => r.month)).toEqual(['2026-07', '2026-08', '2026-09', '2027-06'])
    expect(p.rows[1]).toEqual({ month: '2026-08', site_labor: 653907, overhead_labor: 40230, revenue: 1026956, supplies: 125000,
      details: { school_days: 15, staff_days: 0, closure_days: 0, summer_days: 6, stat_holidays: 0 } })
  })
  it('flags a row whose parts do not add up to its total, and a table without a header', () => {
    expect(parseBudget(PLANO.replace('$694,137', '$700,000')).errors).toEqual(['Aug 2026: site + overhead (694137) does not equal total labor (700000)'])
    expect(parseBudget('a\tb\n1\t2').errors[0]).toMatch(/No header row/)
  })
  it('reads CSV too', () => {
    const p = parseBudget('Month,Site labor,Overhead labor,Revenue\n2026-10,"$739,538","$42,146","$1,026,956"')
    expect(p.rows).toEqual([{ month: '2026-10', site_labor: 739538, overhead_labor: 42146, revenue: 1026956, supplies: null, details: {} }])
  })
})

describe('helpers', () => {
  it('months, amounts and quoted cells', () => {
    expect(['Jul 2026', 'September 2026', '2026-07', '7/2026', '07/01/2026', 'Year'].map(parseMonth)).toEqual(['2026-07', '2026-09', '2026-07', '2026-07', '2026-07', null])
    expect(['$1,026,956', '(1,200)', '', '67.6%', 'abc'].map(parseAmount)).toEqual([1026956, -1200, null, 67.6, NaN])
    expect(splitTable('"a\nb"\tc\n1\t2')).toEqual([['a\nb', 'c'], ['1', '2']])
  })
})

describe('weekly calendar', () => {
  const WEEKS = [
    'Week ending\tSite labor\tOverhead labor\tStat holiday labor\tSchool days\tStaff days\tClosure days\tSummer days\tStat holidays',
    '2026-09-06\t$194,614.48\t$9,578.54\t$0.00\t5\t0\t0\t0\t0',
    '9/13/2026\t155691.58\t9578.54\t37069.42\t4\t0\t0\t0\t1',
  ].join('\n')
  it('reads the weekly budget, keeping stat holiday pay apart', () => {
    const p = parseBudget(WEEKS)
    expect(p.kind).toBe('weeks')
    expect(p.errors).toEqual([])
    expect(p.weeks[1]).toEqual({ week_end: '2026-09-13', site_labor: 155691.58, overhead_labor: 9578.54, holiday_labor: 37069.42,
      details: { school_days: 4, staff_days: 0, closure_days: 0, summer_days: 0, stat_holidays: 1 } })
  })
  it('refuses a week that does not end on Sunday', () => {
    expect(parseBudget(WEEKS.replace('9/13/2026', '9/12/2026')).errors).toEqual(['9/12/2026: weeks end on a Sunday'])
  })
  it('reads day formats', () => {
    expect(['2026-09-13', '9/13/2026', 'Sep 13, 2026', 'x'].map(parseDay)).toEqual(['2026-09-13', '2026-09-13', '2026-09-13', null])
  })
})
