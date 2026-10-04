import { describe, expect, it } from 'vitest'
import { budgetVariance, qaTone } from './Qa'

describe('QA scores', () => {
  it('tones a score by the pass and warn lines', () => {
    expect([qaTone(95), qaTone(90), qaTone(87), qaTone(85), qaTone(84.9), qaTone(null)]).toEqual(['ok', 'ok', 'warn', 'warn', 'bad', ''])
  })
  it('measures labor against budget dollars, null without a budget', () => {
    expect(budgetVariance({ labor: 11_000, budget_dollars: 10_000 })).toBeCloseTo(0.1)
    expect(budgetVariance({ labor: 9_000, budget_dollars: 10_000 })).toBeCloseTo(-0.1)
    expect(budgetVariance({ labor: 9_000, budget_dollars: 0 })).toBeNull()
  })
})
