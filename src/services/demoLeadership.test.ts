import { describe, expect, it } from 'vitest'
import fixture from '../leadership/fixtures/plano-we-2026-09-20.json'
import { accountSummary } from '../leadership/metrics'
import { createDemoApi } from './demoApi'

const api = createDemoApi({ latencyMs: 0 })

describe('demo leadership adapter', () => {
  it('serves the reference week for Plano, so demo numbers equal the reference', async () => {
    const config = await api.leadershipConfig()
    expect(config.default_week).toBe('2026-09-14')
    expect(config.accounts.map((a) => a.slug)).toContain('plano-isd')
    const { rows } = await api.leadershipRows({ week: '2026-09-20', account: 'plano-isd' })
    expect(rows).toHaveLength(86)
    const s = accountSummary(rows, { target: 0.645, divisor: 4.33 }, fixture.segments)
    expect(s.all.invoice).toBeCloseTo(fixture.expected.weeklyInvoice, 6)
    expect(s.account.laborPct!).toBeCloseTo(fixture.expected.accountLp, 10)
  })

  it('returns trend weeks, other featured accounts and a site drawer', async () => {
    const trend = await api.leadershipRows({ week: '2026-09-14', weeks: 13, account: 'plano-isd' })
    expect(trend.weeks).toHaveLength(13)
    const featured = await api.leadershipRows({ account: 'featured' })
    expect(new Set(featured.rows.map((r) => r.account_slug)).size).toBeGreaterThan(5)
    const site = await api.leadershipSite('Crane Southwest', '853', { weeks: 13 })
    expect(site.weeks).toHaveLength(13)
    expect(site.invoices.total).toBe(14132)
    await expect(api.leadershipUpload(new File(['x'], 'x.csv'))).rejects.toThrow(/demo mode/)
  })
})
