import { describe, expect, it } from 'vitest'
import { api } from './api'
import { createDemoApi } from './demoApi'

describe('demo adapter', () => {
  const demo = createDemoApi({ latencyMs: 0 })

  it('implements every live route', () => {
    expect(Object.keys(demo).sort()).toEqual(Object.keys(api).sort())
  })

  it('reports empty marts so the shell labels the data as demo', async () => {
    expect((await demo.systemStatus()).marts.job_month_rows).toBe(0)
  })

  it('refuses actions that would change data', async () => {
    await expect(demo.syncAll()).rejects.toThrow(/demo mode/)
    await expect(demo.leadershipMapJob('Crane IFS', '1', { account_slug: null })).rejects.toThrow(/demo mode/)
  })
})
