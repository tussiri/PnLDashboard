import { describe, expect, it } from 'vitest'
import { hrSyncMessage } from './Admin'

describe('hrSyncMessage', () => {
  it('says how much billing went to HR', () => {
    expect(hrSyncMessage({ status: 'succeeded', billing: { status: 'succeeded', sent: 1234, stored: 1200 } }))
      .toEqual({ ok: true, text: 'HR synced. Billing sent for 1,234 site months, 1,200 stored.' })
  })

  it('does not read as done when a part was skipped for a missing setting', () => {
    const missing = 'HR_EXPORT_TOKEN is not set on the API service'
    const message = hrSyncMessage({ status: 'succeeded', staffing_skipped: missing, billing: { status: 'skipped', skipped: missing } })
    expect(message.ok).toBe(false)
    expect(message.text).toContain(missing)
  })
})
