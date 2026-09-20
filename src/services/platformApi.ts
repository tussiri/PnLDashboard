/**
 * Legacy entry point retained for HANDOFF.md references. The typed client now
 * lives in ./api.ts; this module re-exports the platform routes from it.
 */
import { api } from './api'
export type { IntegrationStatus, SystemStatus as PlatformStatus } from './apiTypes'

export const platformApi = {
  status: api.systemStatus,
  winTeamStatus: api.integrationStatus,
  freshness: api.freshness,
}
