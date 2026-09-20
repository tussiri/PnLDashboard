import type { JobSite, MonthlyPerformance, Period } from '../types'
import { jobs, monthlyPerformance } from '../data/seed'

/** Filters for the seeded repository (browser demo only). */
export interface SeedFilters {
  period: Period
  region: 'All' | JobSite['region']
  serviceType: 'All' | JobSite['serviceType']
  status: 'All' | JobSite['status']
}

export interface OperationsRepository {
  listJobs(filters: SeedFilters): Promise<JobSite[]>
  getJob(id: string): Promise<JobSite | null>
  getPerformance(filters: SeedFilters): Promise<MonthlyPerformance[]>
}

export interface FinancialRepository {
  getPerformance(filters: SeedFilters): Promise<MonthlyPerformance[]>
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class MockAnalyticsRepository implements OperationsRepository, FinancialRepository {
  async listJobs(filters: SeedFilters) {
    await delay(140)
    return jobs.filter((job) =>
      (filters.region === 'All' || job.region === filters.region) &&
      (filters.serviceType === 'All' || job.serviceType === filters.serviceType) &&
      (filters.status === 'All' || job.status === filters.status),
    )
  }

  async getJob(id: string) {
    await delay(80)
    return jobs.find((job) => job.id === id) ?? null
  }

  async getPerformance() {
    await delay(120)
    return monthlyPerformance
  }
}

export const analyticsRepository = new MockAnalyticsRepository()
