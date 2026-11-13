import { describe, expect, it } from 'vitest'
import type { LeadershipRow, StaffingSitesResponse } from '../../services/apiTypes'
import { selfPerformed, staffedOf } from './Sites'

type HrSite = StaffingSitesResponse['sites'][number]
const hr = (job_number: string, x: Partial<HrSite> = {}): HrSite => ({ company: 'Crane', job_number, week_start: '2026-10-26', hires: 1, separations: 0, budgeted_positions: 10,
  positions_source: 'tracker', filled_positions: 9, open_positions: 1, active_headcount: 9, headcount_source: 'employee_master', hr_as_of: '2026-10-27', state_week: '2026-10-26', ...x })
const index = (sites: HrSite[]) => new Map(sites.map((s) => [`${s.company}|${s.job_number}`, s]))
const row = (x: Partial<LeadershipRow> & { kids?: string[] }) => ({ company: 'Crane', job_number: '100', delivery_model: null, hours: 40, ...x }) as never

describe('Sites HR staffing', () => {
  it('counts a site with no delivery model as self-performed only when it has hours', () => {
    expect(selfPerformed(row({}))).toBe(true)
    expect(selfPerformed(row({ hours: 0 }))).toBe(false)
    expect(selfPerformed(row({ delivery_model: 'subcontracted', hours: 40 }))).toBe(false)
    expect(selfPerformed(row({ delivery_model: 'self_perform', hours: 0 }))).toBe(true)
  })

  it('sums the rolled-in jobs of a site', () => {
    const s = staffedOf(row({ kids: ['100', '101'] }), index([hr('100'), hr('101', { budgeted_positions: 4, filled_positions: 2, open_positions: 2, hires: 0, state_week: '2026-10-19' })]))
    expect(s).toMatchObject({ positions: 14, filled: 11, open: 3, hires: 1, asOf: '2026-10-19' })
  })

  it('is null when HR has nothing for the site', () => {
    expect(staffedOf(row({}), index([hr('200')]))).toBeNull()
    expect(staffedOf(row({}), index([hr('100', { week_start: null, state_week: null })]))).toBeNull()
  })

  it('counts people working as filled where the tracker has no filled count', () => {
    expect(staffedOf(row({}), index([hr('100', { filled_positions: null, active_headcount: 8 })]))).toMatchObject({ filled: 8, positions: 10, peopleFrom: 'hr' })
  })

  it('falls back to people who worked per timekeeping when HR has no positions or headcount', () => {
    const s = staffedOf(row({}), index([hr('100', { budgeted_positions: null, filled_positions: null, active_headcount: null, open_positions: null, people_worked: 12 })]))
    expect(s).toMatchObject({ positions: null, filled: 12, people: 12, peopleFrom: 'timekeeping' })
  })

  it('shows a site HR does not send when timekeeping has people', () => {
    expect(staffedOf(row({}), index([hr('100', { week_start: null, state_week: null, hires: null, separations: null, budgeted_positions: null,
      filled_positions: null, active_headcount: null, open_positions: null, people_worked: 5 })]))?.filled).toBe(5)
  })

  it('keeps an unknown figure unknown rather than zero', () => {
    expect(staffedOf(row({}), index([hr('100', { budgeted_positions: null })]))?.positions).toBeNull()
  })
})
