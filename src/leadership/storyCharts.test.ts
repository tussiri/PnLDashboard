import { describe, expect, it } from 'vitest'
import { GLOSSARY } from './glossary'
import { dataVersionOf } from './refresh'
import { startPhase } from './reveal'
import { niceRange, niceTicks } from './storyCharts'
import type { LeadershipConfig } from '../services/apiTypes'

describe('startPhase', () => {
  it('plays a section already in view and waits for one below the fold', () => {
    expect(startPhase({ motionOk: true, hasObserver: true, inView: true })).toBe('play')
    expect(startPhase({ motionOk: true, hasObserver: true, inView: false })).toBe('waiting')
  })
  it('draws everything still with reduced motion or without an observer', () => {
    expect(startPhase({ motionOk: false, hasObserver: true, inView: false })).toBe('static')
    expect(startPhase({ motionOk: true, hasObserver: false, inView: false })).toBe('static')
  })
})

describe('axis ticks', () => {
  it('steps by 1, 2, 2.5 or 5 times a power of ten up to the maximum', () => {
    expect(niceTicks(830_000)).toEqual([0, 250_000, 500_000, 750_000, 1_000_000])
    expect(niceTicks(0)).toEqual([0])
  })
  it('covers negatives and keeps zero on a tick', () => {
    const t = niceRange(-30, 95)
    expect(t[0]).toBeLessThanOrEqual(-30)
    expect(t.at(-1)).toBeGreaterThanOrEqual(95)
    expect(t).toContain(0)
  })
})

describe('dataVersionOf', () => {
  it('changes with either rebuild time', () => {
    const config = (a: string, b: string) => ({ status: { rebuilt_at: a, leadership_rebuilt_at: b } }) as unknown as LeadershipConfig
    expect(dataVersionOf(undefined)).toBeUndefined()
    expect(dataVersionOf(config('1', '2'))).not.toBe(dataVersionOf(config('1', '3')))
  })
})

describe('glossary', () => {
  it('defines every term with a definition', () => {
    for (const [key, d] of Object.entries(GLOSSARY)) {
      expect(d.term, key).toBeTruthy()
      expect(d.definition.length, key).toBeGreaterThan(20)
    }
  })
})

describe('docs/METRICS.md', () => {
  it('has an entry for every glossary term', async () => {
    const { readFileSync } = await import('node:fs')
    const doc = readFileSync(new URL('../../docs/METRICS.md', import.meta.url), 'utf8')
    for (const d of Object.values(GLOSSARY)) expect(doc).toContain(`### ${d.term}`)
  })
})
