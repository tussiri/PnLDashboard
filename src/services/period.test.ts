import { describe, expect, it } from 'vitest'
import { addMonths, monthLabel, priorRange, rangeLabel, resolveRange } from './period'

describe('period resolution and range labels', () => {
  it('mirrors the server rules for MTD/QTD/YTD/T12M', () => {
    expect(resolveRange('MTD', '2026-08-01')).toEqual({ from: '2026-08-01', to: '2026-08-01', months: 1 })
    expect(resolveRange('QTD', '2026-08-01')).toEqual({ from: '2026-07-01', to: '2026-08-01', months: 2 })
    expect(resolveRange('QTD', '2026-03-01')).toEqual({ from: '2026-01-01', to: '2026-03-01', months: 3 })
    expect(resolveRange('YTD', '2026-08-01')).toEqual({ from: '2026-01-01', to: '2026-08-01', months: 8 })
    expect(resolveRange('T12M', '2026-02-01')).toEqual({ from: '2025-03-01', to: '2026-02-01', months: 12 })
  })

  it('builds the equivalent prior range for deltas', () => {
    expect(priorRange('MTD', resolveRange('MTD', '2026-01-01'))).toEqual({ from: '2025-12-01', to: '2025-12-01', months: 1 })
    expect(priorRange('YTD', resolveRange('YTD', '2026-08-01'))).toEqual({ from: '2025-01-01', to: '2025-08-01', months: 8 })
    expect(priorRange('QTD', resolveRange('QTD', '2026-08-01'))).toEqual({ from: '2026-04-01', to: '2026-05-01', months: 2 })
    expect(priorRange('T12M', resolveRange('T12M', '2026-08-01'))).toEqual({ from: '2024-09-01', to: '2025-08-01', months: 12 })
  })

  it('formats the resolved range for the filter bar', () => {
    expect(rangeLabel({ from: '2026-01-01', to: '2026-08-01', months: 8 })).toBe('Jan–Aug 2026 · 8 months')
    expect(rangeLabel({ from: '2026-08-01', to: '2026-08-01', months: 1 })).toBe('Aug 2026 · 1 month')
    expect(rangeLabel({ from: '2025-09-01', to: '2026-08-01', months: 12 })).toBe('Sep 2025–Aug 2026 · 12 months')
    expect(rangeLabel(null)).toBe('')
    expect(monthLabel('2026-08-01', 'tick')).toBe('Aug 26')
    expect(addMonths('2026-01-01', -1)).toBe('2025-12-01')
  })
})
