import { describe, expect, it } from 'vitest'
import { ApiError } from '../services/api'
import { apiAbsent } from './useAuth'

describe('auth backend detection', () => {
  it('falls back to the browser-only demo sign-in when no API answers /auth/mode', () => {
    expect(apiAbsent(new ApiError(0, 'Failed to fetch', '/auth/mode'))).toBe(true)
    expect(apiAbsent(new ApiError(503, 'Service unavailable', '/auth/mode'))).toBe(true)
    expect(apiAbsent(new ApiError(500, 'Internal error', '/auth/mode'))).toBe(true)
    // Vite serves /api/v1/* itself under NO_API_PROXY=1 and answers 404: that is "no API", not a refusal.
    expect(apiAbsent(new ApiError(404, 'Not Found', '/auth/mode'))).toBe(true)
    expect(apiAbsent(new TypeError('network down'))).toBe(true)
  })
  it('keeps the real sign-in when a reachable API refuses the call', () => {
    expect(apiAbsent(new ApiError(401, 'Unauthorized', '/auth/mode'))).toBe(false)
    expect(apiAbsent(new ApiError(403, 'Forbidden', '/auth/mode'))).toBe(false)
    expect(apiAbsent(new ApiError(400, 'Bad request', '/auth/mode'))).toBe(false)
  })
})
