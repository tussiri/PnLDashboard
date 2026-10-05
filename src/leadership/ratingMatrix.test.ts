import { describe, expect, it } from 'vitest'
import type { LeadershipFeedbackResponse } from '../services/apiTypes'
import { matrixMonths, ratingMatrix } from './pages/Feedback'

type Line = LeadershipFeedbackResponse['lines'][number]
const line = (p: Partial<Line>): Line => ({ wo_number: 'w', location_number: '331', provider_name: null, trade: null, feedback: null, feedback_date: '2026-09-02',
  comment: null, score: 5, company: 'Crane IFS', job_number: '51', site_name: 'FedEx - Miami', account_slug: 'fedex', match_basis: 'relay', ...p } as Line)

describe('star rating matrix', () => {
  it('lists the months from the window start through the newest rating', () => {
    expect(matrixMonths('2025-11-01', [{ feedback_date: '2026-02-14' }])).toEqual(['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01'])
  })
  it('averages each site by month, counts 1-2 stars and puts the lowest average first', () => {
    const rows = ratingMatrix([
      line({ score: 5, feedback_date: '2026-08-03' }), line({ score: 2, feedback_date: '2026-08-20' }), line({ score: 4, feedback_date: '2026-09-01' }),
      line({ score: null, feedback_date: '2026-09-02' }),
      line({ company: null, job_number: null, site_name: null, location_number: '0999', score: 3 }),
    ])
    expect(rows.map((r) => r.name)).toEqual(['Location 0999', 'FedEx - Miami'])
    const miami = rows[1]
    expect(miami.months['2026-08-01']).toEqual({ average: 3.5, ratings: 2, low: 1 })
    expect(miami.months['2026-09-01']).toEqual({ average: 4, ratings: 1, low: 0 })
    expect(miami).toMatchObject({ ratings: 4, low: 1 })
    expect(miami.average).toBeCloseTo(11 / 3)
  })
})
