import { describe, expect, it } from 'vitest'
import { EMPTY_FILTERS, filterLines, groupRows, options, rollingSeries, stats, valueOf, type Line } from './feedbackExplorer'

const line = (o: Partial<Line>): Line => ({ wo_number: Math.random().toString(36), location_number: '0100', provider_name: 'Crane', trade: 'JANITORIAL DOCK', feedback: null,
  feedback_date: '2026-10-01', comment: null, score: 5, company: 'Crane IFS', job_number: '1', site_name: 'FedEx - A', account_slug: 'fedex', match_basis: 'relay',
  region: 'West', subregion: 'CA', delivery_model: 'self_perform', opco: 'FXG', ...o })

const lines = [
  line({ score: 1, feedback_date: '2026-10-30', comment: 'Dock dirty', region: 'West' }),
  line({ score: 5, feedback_date: '2026-10-30', trade: 'JANITORIAL OFFICE', region: 'West' }),
  line({ score: 4, feedback_date: '2026-09-01', region: 'Southeast', location_number: 'BWIA', opco: 'FXE', site_name: 'FedEx - B', delivery_model: 'subcontracted' }),
  line({ score: null, feedback_date: '2026-08-01', region: null }),
]

describe('feedback explorer', () => {
  it('averages every rating, not visits, and counts unscored ratings apart', () => {
    const s = stats(lines)
    expect(s.ratings).toBe(4)
    expect(s.scored).toBe(3)
    expect(s.average).toBeCloseTo((1 + 5 + 4) / 3, 6)
    expect(s.low).toBe(1)
    expect(s.sites).toBe(2)
    expect(s.comments).toBe(1)
  })

  it('filters by dimension, score, comments, search and period from the newest rating', () => {
    expect(filterLines(lines, { ...EMPTY_FILTERS, values: { region: 'West' } })).toHaveLength(2)
    expect(filterLines(lines, { ...EMPTY_FILTERS, values: { opco: 'FXE', delivery: 'Subcontracted' } })).toHaveLength(1)
    expect(filterLines(lines, { ...EMPTY_FILTERS, score: 'low' })).toHaveLength(1)
    expect(filterLines(lines, { ...EMPTY_FILTERS, comments: true })).toHaveLength(1)
    expect(filterLines(lines, { ...EMPTY_FILTERS, search: 'dock' })).toHaveLength(1)
    expect(filterLines(lines, { ...EMPTY_FILTERS, days: 30 })).toHaveLength(2)
    expect(valueOf(lines[3], 'region')).toBe('None')
    expect(valueOf(lines[1], 'trade')).toBe('Office')
    expect(options(lines, 'region')[0]).toEqual({ value: 'West', n: 2 })
  })

  it('groups with the running window and the change against the window before', () => {
    const rows = groupRows(lines, 'region', 30)
    const west = rows.find((r) => r.key === 'West')!
    expect(west.average).toBe(3)
    expect(west.recent).toBe(3)
    expect(west.recentN).toBe(2)
    const se = rows.find((r) => r.key === 'Southeast')!
    expect(se.recent).toBeNull()
    expect(se.prior).toBe(4)
    expect(se.change).toBeNull()
  })

  it('builds weekly running averages that end on the newest rating', () => {
    const r = rollingSeries([{ label: 'All', lines }], 30)
    expect(r.labels.at(-1)).toBe('2026-10-30')
    const last = r.series[0]
    expect(last.data.at(-1)).toBe(3)
    expect(last.counts.at(-1)).toBe(2)
    expect(r.labels.every((l, i) => i === r.labels.length - 1 || new Date(`${l}T00:00:00Z`).getUTCDay() === 0)).toBe(true)
  })
})
