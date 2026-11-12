import { describe, expect, it } from 'vitest'
import type { LeadershipFeedbackLine, ServiceTicket } from '../services/apiTypes'
import {
  commentVisits, defaultFilters, inMonths, inScope, monthList, placeTickets, priorRange, siteRows, summarize, ticketStats, toRatings,
} from './feedbackModel'

const line = (o: Partial<LeadershipFeedbackLine>): LeadershipFeedbackLine => ({
  wo_number: Math.random().toString(36).slice(2), location_number: '100', provider_name: null, trade: 'JANITORIAL DOCK', feedback: null,
  feedback_date: '2026-01-10', comment: null, score: 5, company: 'Crane', job_number: '100', site_name: 'FedEx - Alpha', account_slug: 'fedex',
  match_basis: 'relay', region: 'West', delivery_model: 'self_perform', opco: 'FXG', ...o })

const ticket = (o: Partial<ServiceTicket>): ServiceTicket => ({
  ticket_number: '1', status: 'Open', open: true, assigned_to: null, opco: 'FXG', location_number: '100', location_label: null, city_state: null,
  provider: null, issue_type: 'SOW Not Performed', escalation_level: 'Level 1', date_received: '2026-03-01', date_acknowledged: null, date_closed: null,
  expected_close: null, days_open: 10, notes: null, latest_note: null, company: 'Crane', job_number: '100', site_name: 'FedEx - Alpha', match_basis: 'relay', ...o })

describe('feedbackModel', () => {
  const lines = [
    line({ feedback_date: '2026-01-10', score: 5 }),
    line({ feedback_date: '2026-02-10', score: 4, comment: 'No comment' }),
    line({ feedback_date: '2026-04-10', score: 1, comment: 'Dock not cleaned', trade: 'JANITORIAL OFFICE' }),
    line({ feedback_date: '2026-04-10', score: 2, comment: 'dock not cleaned' }),
    line({ feedback_date: '2026-04-12', score: null }),
    line({ location_number: '0200', company: null, job_number: null, site_name: null, feedback_date: '2026-04-11', score: 3, delivery_model: 'subcontracted', region: null }),
  ]
  const ratings = toRatings(lines)

  it('drops unscored ratings and placeholder comments, keys unmatched locations by code', () => {
    expect(ratings).toHaveLength(5)
    expect(ratings[1].comment).toBeNull()
    expect(ratings[4]).toMatchObject({ key: 'loc|200', site: 'Location 0200', region: 'Unmapped', delivery: 'subcontracted' })
  })

  it('lists every month and finds the prior period of the same length', () => {
    const months = monthList(ratings)
    expect(months).toEqual(['2026-01', '2026-02', '2026-03', '2026-04'])
    expect(priorRange(2, 3)).toEqual({ from: 0, to: 1 })
    expect(priorRange(1, 3)).toBeNull()
    expect(inMonths('2026-03', months, 2, 3)).toBe(true)
    expect(inMonths(null, months, 0, 3)).toBe(false)
  })

  it('filters by delivery, trade, stars and search', () => {
    const f = defaultFilters(4)
    expect(ratings.filter((r) => inScope(r, { ...f, delivery: 'subcontracted' }))).toHaveLength(1)
    expect(ratings.filter((r) => inScope(r, { ...f, trades: ['Dock'] }))).toHaveLength(4)
    expect(ratings.filter((r) => inScope(r, { ...f, minStars: 1, maxStars: 2 }))).toHaveLength(2)
    expect(ratings.filter((r) => inScope(r, { ...f, minStars: 1, maxStars: 2 }, { stars: false }))).toHaveLength(5)
    expect(ratings.filter((r) => inScope(r, { ...f, q: '0200' }))).toHaveLength(1)
  })

  it('summarizes ratings, visits and low sites', () => {
    const s = summarize(ratings)
    expect(s).toMatchObject({ ratings: 5, visits: 4, low: 2, five: 1, sites: 2, sitesBelow: 2 })
    expect(s.average).toBeCloseTo(3)
  })

  it('groups comments by visit, once each, with the lowest score', () => {
    const v = commentVisits(ratings)
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ date: '2026-04-10', comments: ['Dock not cleaned'], min: 1 })
  })

  it('compares each site with the prior period', () => {
    const cur = toRatings([1, 2, 2].map((score) => line({ score, feedback_date: '2026-04-01' })))
    const pre = toRatings([5, 5, 4].map((score) => line({ score, feedback_date: '2026-02-01' })))
    expect(siteRows(cur, [], 5, pre)[0].change).toBeCloseTo(5 / 3 - 14 / 3)
    expect(siteRows(cur, [], 5, pre.slice(0, 2))[0].change).toBeNull()
    expect(siteRows(cur, [])[0].change).toBeNull()
  })

  it('places tickets on rated sites and compares ratings around them', () => {
    const t = placeTickets([ticket({}), ticket({ ticket_number: '2', location_number: 'ZZZ', company: null, job_number: null, site_name: null, city_state: 'Nowhere, TX', open: false, date_closed: '2026-03-20' })], ratings)
    expect(t[0]).toMatchObject({ key: 'Crane|100', rated: true, region: 'West' })
    expect(t[1]).toMatchObject({ key: 'loc|ZZZ', rated: false, site: 'ZZZ, Nowhere, TX' })
    const st = ticketStats(ratings, ratings, t)
    expect(st.withTicket.sites).toBe(1)
    expect(st.without.sites).toBe(1)
    expect(st.before.tickets).toBe(1)
    expect(st.before.average).toBeCloseTo(4.5)
    expect(st.daysToClose).toBe(19)
    const rows = siteRows(ratings, t)
    expect(rows.find((r) => r.key === 'Crane|100')).toMatchObject({ tickets: 1, ratings: 4, low: 2 })
  })
})
