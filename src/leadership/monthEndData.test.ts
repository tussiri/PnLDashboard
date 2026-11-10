import { describe, expect, it } from 'vitest'
import { demoCompanyPl } from '../services/demoCompanyPl'
import { formatRoute, parseRoute } from './routes'
import { fk } from './MonthEnd'
import { bridgeOf, columnsOf, companyNames, groupOver, marginStatus, periodOf, periodsOf, rankCustomers, sumMonths } from './monthEndData'

const pl = demoCompanyPl()
const months = pl.months

describe('month-end periods and sums', () => {
  it('lists each month latest first, then the year to date and the last two months', () => {
    const periods = periodsOf(months)
    expect(periods.slice(0, 2).map((p) => p.label)).toEqual(['October 2026', 'September 2026'])
    expect(periods.at(-2)).toMatchObject({ key: 'ytd', label: '2026 year to date', short: 'Jan–Oct', idx: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] })
    expect(periods.at(-1)).toMatchObject({ key: 'last2', label: 'September and October 2026', short: 'Sep + Oct', idx: [8, 9] })
    expect(periodOf(periods, undefined)?.key).toBe('2026-10')
    expect(periodOf(periods, 'nope')?.key).toBe('2026-10')
    expect(columnsOf(months, periods).map((c) => c.short)).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Jan–Oct', 'Sep + Oct'])
  })

  it('sums every amount and recomputes the ratios; groups, customers and companies add up to net profit', () => {
    const s = sumMonths(months, [8, 9])
    expect(s.company.net_profit).toBeCloseTo(months[8].company.net_profit + months[9].company.net_profit, 2)
    expect(s.company.net_margin).toBeCloseTo(s.company.net_profit / s.company.revenue, 6)
    expect(s.groups.reduce((a, g) => a + g.after_overhead, 0)).toBeCloseTo(s.company.net_profit, 0)
    expect((s.customers ?? []).reduce((a, c) => a + c.after_overhead, 0)).toBeCloseTo(s.company.net_profit, 0)
    expect(Object.values(s.companies ?? {}).reduce((a, c) => a + c.net_profit, 0)).toBeCloseTo(s.company.net_profit, 0)
    expect(Object.values(s.ebita!.groups).reduce((a, g) => a + g.ebita, 0)).toBeCloseTo(s.ebita!.ebita, 0)
    expect(groupOver(months, [8, 9], 'fedex_subs')?.fixed_charge).toBe(60000)
    // The months themselves are not changed by summing.
    expect(months[8].company.net_profit).not.toBeCloseTo(s.company.net_profit, 0)
  })

  it('ranks customers by profit and loss, and labels margins', () => {
    const { top, bottom } = rankCustomers(sumMonths(months, [9]).customers ?? [], 'after')
    expect(top.every((c, i) => i === 0 || c.after_overhead <= top[i - 1].after_overhead)).toBe(true)
    expect(bottom.every((c) => c.after_overhead < 0)).toBe(true)
    expect([marginStatus(null), marginStatus(-0.01), marginStatus(0.02), marginStatus(0.05)]).toEqual(['none', 'loss', 'thin', 'profit'])
    expect(companyNames(months)).toEqual(['Crane IFS', 'Sarus'])
  })
})

describe('the GL to pro forma bridge', () => {
  it('takes the adjustments off the month for the GL as posted, by company and by group', () => {
    const oct = months[9]
    const b = bridgeOf(oct, months[8])
    expect(b.lines).toHaveLength(3)
    expect(b.gl.net).toBeCloseTo(oct.company.net_profit - (96000 + 85500 - 52000), 2)
    expect(b.gl.revenue).toBeCloseTo(oct.company.revenue - 181500, 2)
    expect(b.gl.cost).toBeCloseTo(b.gl.revenue - b.gl.net, 2)
    const fedex = b.groups.find((g) => g.key === 'fedex_subs')!
    expect(fedex.adjustments).toBe(96000)
    expect(fedex.gl).toBeCloseTo(fedex.proForma - 96000, 2)
    expect(fedex.prior).toBe(months[8].groups.find((g) => g.key === 'fedex_subs')!.before_overhead)
    expect(b.groups.at(-1)).toMatchObject({ key: 'overhead', proForma: -oct.overhead.cost })
  })

  it('is the month itself when nothing is adjusted', () => {
    const b = bridgeOf(months[3], null)
    expect(b.lines).toEqual([])
    expect(b.gl.net).toBe(months[3].company.net_profit)
    expect(b.groups[0].prior).toBeNull()
  })
})

describe('month-end routes and formats', () => {
  it('round-trips the tab and period', () => {
    const r = parseRoute('#/company/month-end/customers?p=ytd')
    expect(r).toMatchObject({ view: 'company', monthEnd: { tab: 'customers', period: 'ytd' } })
    expect(formatRoute(r)).toBe('#/company/month-end/customers?p=ytd')
    expect(parseRoute('#/company/month-end').monthEnd).toEqual({})
    expect(formatRoute({ view: 'company', monthEnd: {} })).toBe('#/company/month-end')
    expect(parseRoute('#/company/month-end/nope?p=junk').monthEnd).toEqual({})
    expect(parseRoute('#/company').monthEnd).toBeUndefined()
  })

  it('formats compact dollars with negatives in parentheses', () => {
    expect([fk(1_240_000), fk(184_400), fk(-32_100), fk(450), fk(null)]).toEqual(['$1.24M', '$184K', '($32K)', '$450', '–'])
  })
})
