import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * UI copy rules: no symbol glyphs (arrows, box drawing, geometric shapes, dingbats, emoji) and no
 * placeholder brand. Deltas and navigation use lucide icons plus text instead.
 * The executive view mirrors the executives' original dashboard and is exempt.
 */
const FORBIDDEN = /[←-⇿─-➿⬀-⯿\u{1F300}-\u{1FAFF}]/u
const SRC = join(__dirname)
const EXEMPT = [/^views\/ExecutivePL\.tsx$/, /^components\/executive\//, /^styles\/executive\.css$/, /\.test\.tsx?$/]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(tsx?|css)$/.test(name) ? [path] : []
  })
}

const files = sourceFiles(SRC).map((path) => relative(SRC, path)).filter((file) => !EXEMPT.some((rule) => rule.test(file)))

describe('user-facing copy', () => {
  it('scans the views and components', () => {
    expect(files.some((f) => f === 'views/Financial.tsx')).toBe(true)
    expect(files.some((f) => f === 'components/AppShell.tsx')).toBe(true)
  })

  it.each(files)('%s contains no symbol glyphs', (file) => {
    const lines = readFileSync(join(SRC, file), 'utf8').split('\n')
    const offending = lines.map((line, i) => (FORBIDDEN.test(line) ? `${i + 1}: ${line.trim().slice(0, 120)}` : null)).filter(Boolean)
    expect(offending).toEqual([])
  })

  it.each(files)('%s does not use the placeholder brand', (file) => {
    expect(readFileSync(join(SRC, file), 'utf8')).not.toMatch(/Northstar/)
  })
})
