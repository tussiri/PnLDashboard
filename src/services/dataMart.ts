import type { MonthlyPerformance } from '../types'
import type { SeedFilters as GlobalFilters } from './adapters'

export interface FinancialDataMartClient {
  getMonthlyPerformance(filters: GlobalFilters): Promise<MonthlyPerformance[]>
  getSemanticMetric(metricKey: string, filters: GlobalFilters): Promise<number | null>
}

export class UnconfiguredFinancialDataMartClient implements FinancialDataMartClient {
  async getMonthlyPerformance(): Promise<never> {
    throw new Error('Financial data mart connection is not configured.')
  }
  async getSemanticMetric(): Promise<never> {
    throw new Error('Financial data mart connection is not configured.')
  }
}
