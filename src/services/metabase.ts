export type MetabaseEmbedTarget = { kind: 'dashboard' | 'question'; resourceId: number }

export interface MetabaseEmbedRequest {
  target: MetabaseEmbedTarget
  params: Record<string, string | number | string[]>
  expiresInMinutes?: number
}

export interface MetabaseEmbedProvider {
  createEmbedUrl(request: MetabaseEmbedRequest): Promise<string>
}

export class UnconfiguredMetabaseEmbedProvider implements MetabaseEmbedProvider {
  async createEmbedUrl(): Promise<never> {
    throw new Error('Metabase embedding is not configured. Generate signed URLs on the server; never expose the signing secret in the browser.')
  }
}
