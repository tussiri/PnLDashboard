import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// compose.yaml passes environment to the api/worker containers through an explicit allow-list.
// A variable config.py reads but compose does not list never reaches the container and silently
// keeps its default - which is how COMPANYCAM_API_TOKEN would have stayed "not connected" forever
// however it was set in .env. This keeps the two lists in step.
const ROOT = join(__dirname, '..')
const config = readFileSync(join(ROOT, 'services/api/app/config.py'), 'utf8')
const compose = readFileSync(join(ROOT, 'compose.yaml'), 'utf8')

// DATABASE_URL is an optional override of the discrete DB_* settings compose does pass.
const INTENTIONALLY_UNLISTED = new Set(['DATABASE_URL'])

describe('compose environment allow-list', () => {
  it('passes every variable the API reads', () => {
    const read = new Set([...config.matchAll(/_(?:text|boolean|integer|json_object|float_)\(\s*env,\s*"([A-Z_]+)"/gs)].map((m) => m[1]))
    const passed = new Set([...compose.matchAll(/^\s+([A-Z_]+):/gm)].map((m) => m[1]))
    const missing = [...read].filter((name) => !passed.has(name) && !INTENTIONALLY_UNLISTED.has(name)).sort()
    expect(missing).toEqual([])
  })

  it('finds the variables it is checking', () => {
    // Guards the regexes: an empty match would make the test above pass vacuously.
    expect(config).toMatch(/"WINTEAM_TENANT_ID"/)
    expect(compose).toMatch(/WINTEAM_TENANT_ID:/)
  })
})
