import { describe, expect, it } from 'vitest'
import { sortRows, type Column } from './DataGrid'

type Row = { name: string; margin: number | null; branch: string }
const rows: Row[] = [
  { name: 'B site', margin: 22.5, branch: 'Boston' },
  { name: 'a site', margin: null, branch: 'Atlanta' },
  { name: 'C site', margin: 31, branch: 'Chicago' },
  { name: 'D site', margin: 18, branch: 'Denver' },
]
const margin: Column<Row> = { key: 'margin', header: 'Margin', numeric: true }
const name: Column<Row> = { key: 'name', header: 'Site' }
const derived: Column<Row> = { key: 'len', header: 'Length', value: (r) => r.branch.length }

describe('DataGrid sorting', () => {
  it('sorts numbers in both directions with nulls always last', () => {
    expect(sortRows(rows, margin, 'asc').map((r) => r.name)).toEqual(['D site', 'B site', 'C site', 'a site'])
    expect(sortRows(rows, margin, 'desc').map((r) => r.name)).toEqual(['C site', 'B site', 'D site', 'a site'])
  })

  it('sorts strings case-insensitively and uses derived values when provided', () => {
    expect(sortRows(rows, name, 'asc').map((r) => r.name)).toEqual(['a site', 'B site', 'C site', 'D site'])
    expect(sortRows(rows, derived, 'desc').map((r) => r.branch)).toEqual(['Atlanta', 'Chicago', 'Boston', 'Denver'])
  })

  it('is stable and returns the input when no column is given', () => {
    const tied: Row[] = [{ name: 'x', margin: 1, branch: 'b' }, { name: 'y', margin: 1, branch: 'a' }]
    expect(sortRows(tied, margin, 'desc').map((r) => r.name)).toEqual(['x', 'y'])
    expect(sortRows(rows, undefined, 'asc')).toBe(rows)
  })
})
