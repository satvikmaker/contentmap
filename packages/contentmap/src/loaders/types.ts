import type { Logger, Promisable, ResolvedConfig } from '../types.ts'

/** One record produced by a loader. */
export interface LoadedRecord {
  /**
   * Stable identity.
   *
   * Required, because a remote record has no file path to derive one from. It
   * keys the store, the cache and reference resolution, so a loader that
   * cannot produce a stable id cannot produce incremental builds either.
   */
  id: string
  data: Record<string, unknown>
  /** Body text, for records that carry prose. */
  body?: string
  /** Digest of this record's payload, for change detection. */
  digest: string
}

export interface LoadResult {
  records: LoadedRecord[]
  /** True when the source was unchanged and records came from cache. */
  fromCache: boolean
}

/** Persisted key/value storage, for etags, cursors and sync tokens. */
export interface MetaStore {
  get(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
}

export interface LoaderContext {
  collection: string
  meta: MetaStore
  logger: Logger
  config: ResolvedConfig
  signal: AbortSignal
  /** No network is permitted; satisfy the request from cache or fail. */
  frozen: boolean
  digest(input: string | Uint8Array): string
  /**
   * Read the previous successful snapshot, if any.
   *
   * A loader uses this to answer a 304, an offline build, or a frozen build
   * without refetching.
   */
  snapshot(): LoadedRecord[] | undefined
  /** Record a successful fetch so the next build can revalidate against it. */
  save(records: readonly LoadedRecord[]): void
}

export interface Loader {
  name: string
  load(context: LoaderContext): Promisable<LoadResult>
}

export function defineLoader(loader: Loader): Loader {
  return loader
}
