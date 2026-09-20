import { describe, expect, it } from 'vitest'
import { jobs, monthlyPerformance } from './seed'
import { MockAnalyticsRepository } from '../services/adapters'
import { applyPeriod } from '../utils'

describe('seeded analytics model', () => {
  it('contains a national operating portfolio with valid financials', () => {
    expect(jobs.length).toBeGreaterThanOrEqual(18)
    expect(new Set(jobs.map((job) => job.region))).toEqual(new Set(['Northeast', 'Southeast', 'Central', 'West']))
    for (const job of jobs) {
      const grossProfit = job.revenue - job.labor - job.payrollBurden - job.supplies - job.otherDirectCosts
      expect(job.revenue).toBeGreaterThan(0)
      expect(grossProfit).toBeGreaterThan(0)
      expect(job.actualHours).toBeGreaterThan(0)
      expect(job.latitude).toBeGreaterThan(24)
      expect(job.longitude).toBeLessThan(-65)
    }
  })

  it('provides enough observations for honest trend views', () => {
    expect(monthlyPerformance).toHaveLength(12)
    expect(monthlyPerformance.every((row) => row.revenue > 0 && row.budget > 0)).toBe(true)
  })

  it('changes additive measures when the reporting period changes', () => {
    const mtd = applyPeriod(jobs[0], 'MTD')
    const ytd = applyPeriod(jobs[0], 'YTD')
    expect(ytd.revenue).toBe(mtd.revenue * 8)
    expect(ytd.actualHours).toBe(mtd.actualHours * 8)
    expect(ytd.openReceivables).toBe(mtd.openReceivables)
    expect(ytd.contractValue).toBe(mtd.contractValue)
  })

  it('applies coordinated portfolio filters in the repository boundary', async () => {
    const repository = new MockAnalyticsRepository()
    const result = await repository.listJobs({ period: 'YTD', region: 'West', serviceType: 'Industrial', status: 'All' })
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((job) => job.region === 'West' && job.serviceType === 'Industrial')).toBe(true)
  })
})
