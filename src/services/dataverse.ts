/** Optional boundary only. Live Dataverse is not configured in this workspace. */
export interface DataverseReadModelClient {
  readView<T>(viewName: string, query: Record<string, string>): Promise<T[]>
}

export class UnconfiguredDataverseReadModelClient implements DataverseReadModelClient {
  async readView<T>(): Promise<T[]> {
    throw new Error('Dataverse is an optional integration and is not configured.')
  }
}
