import { describe, expect, it } from 'vitest'
import { toCsv } from './csv'

describe('CSV export', () => {
  it('writes a header, escapes quotes/commas/newlines, and leaves numbers raw', () => {
    const rows = [
      { site: 'Hudson Square, NY', revenue: 1234567.5, note: 'said "hi"\nthen left', missing: null },
      { site: 'Plain', revenue: 0, note: '', missing: undefined },
    ]
    const csv = toCsv(rows, [
      { key: 'site', header: 'Site' },
      { key: 'revenue', header: 'Revenue (USD)' },
      { key: 'note', header: 'Note' },
      { key: 'missing', header: 'Missing' },
      { key: 'derived', header: 'Double', value: (r) => r.revenue * 2 },
    ])
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('Site,Revenue (USD),Note,Missing,Double')
    expect(lines[1]).toBe('"Hudson Square, NY",1234567.5,"said ""hi""\nthen left",,2469135')
    expect(lines[2]).toBe('Plain,0,,,0')
  })
})
