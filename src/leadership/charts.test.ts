import { describe, expect, it } from 'vitest'

describe('percent axis cap', () => {
  it('ignores summer outliers and leaves ordinary ranges alone', async () => {
    const { pctAxisMax } = await import('./charts')
    expect(pctAxisMax([60, 70, 80, 90, 2300, 700, null], 100)).toBe(160)
    expect(pctAxisMax([55, 60, 65, 70], 100)).toBeUndefined()
    expect(pctAxisMax([], 100)).toBeUndefined()
  })
})

describe('withAlpha', () => {
  it('turns a hex token into rgba and leaves other colors alone', async () => {
    const { withAlpha } = await import('./charts')
    expect(withAlpha('#8fb3d6', 0.35)).toBe('rgba(143, 179, 214, 0.35)')
    expect(withAlpha('rgb(1, 2, 3)', 0.5)).toBe('rgb(1, 2, 3)')
  })
})
