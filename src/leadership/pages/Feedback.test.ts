import { describe, expect, it } from 'vitest'
import { groupVisits, tradeName } from './Feedback'

const line = (wo: string, trade: string, score: number | null, comment: string | null, date = '2026-07-02', loc = 'NIPA') => ({
  wo_number: wo, location_number: loc, provider_name: null, trade, feedback: 'Satisfactory', feedback_date: date, comment, score,
  company: 'Crane IFS', job_number: '223', site_name: 'FedEx - NIPA', account_slug: 'fedex', match_basis: 'relay' as const,
})

describe('groupVisits', () => {
  it('folds a visit\'s trade ratings into one row and keeps each distinct comment once', () => {
    const v = groupVisits([
      line('2', 'JANITORIAL OFFICE', 1, 'Warehouse not cleaned properly.'),
      line('1', 'JANITORIAL DOCK', 1, 'warehouse not cleaned properly. '),
      line('3', 'JANITORIAL PALLETS', 4, 'Pallets fine'),
      line('4', 'JANITORIAL DOCK', 5, null, '2026-08-03'),
    ])
    expect(v).toHaveLength(2)
    const july = v.find((x) => x.feedback_date === '2026-07-02')!
    expect(july.ratings.map((r) => `${tradeName(r.trade)} ${r.score}`)).toEqual(['Dock 1', 'Office 1', 'Pallets 4'])
    expect(july.comments).toEqual(['Warehouse not cleaned properly.', 'Pallets fine'])
    expect(july.average).toBe(2)
    expect(july.low).toBe(true)
    expect(v.find((x) => x.feedback_date === '2026-08-03')!.low).toBe(false)
  })
})
