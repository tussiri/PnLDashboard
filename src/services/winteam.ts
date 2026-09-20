import type { JobSite } from '../types'

/**
 * Boundary for TEAM Software Concourse. Endpoint names and payload mappings are
 * intentionally configuration-driven because the detailed WinTeam API catalog
 * is available only after signing into TEAM's API portal.
 */
export interface WinTeamJobRecord {
  externalId: string
  raw: Record<string, unknown>
}

export interface WinTeamClient {
  listJobs(cursor?: string): Promise<{ records: WinTeamJobRecord[]; nextCursor?: string }>
  getJob(externalId: string): Promise<WinTeamJobRecord | null>
}

export type WinTeamJobMapper = (record: WinTeamJobRecord) => Partial<JobSite> & Pick<JobSite, 'winTeamId'>

export class UnconfiguredWinTeamClient implements WinTeamClient {
  async listJobs(): Promise<never> {
    throw new Error('WinTeam is not configured. Add Concourse credentials and a tenant-specific field map.')
  }
  async getJob(): Promise<never> {
    throw new Error('WinTeam is not configured. Add Concourse credentials and a tenant-specific field map.')
  }
}
