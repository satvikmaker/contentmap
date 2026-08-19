import { defineLoader, type LoadedRecord, type Loader, type LoaderContext, type LoadResult } from './types.ts'

export type Revalidate = 'etag' | 'always' | { seconds: number }
export type RemoteErrorPolicy = 'cache' | 'fail' | 'empty'

export interface HttpLoaderOptions<T = unknown> {
  url: string | (() => string | Promise<string>)
  /**
   * Request headers.
   *
   * A FUNCTION, deliberately. It is evaluated per request and never
   * serialized, which is what keeps an Authorization value out of the cache
   * file that sits in the project directory.
   */
  headers?: () => Record<string, string> | Promise<Record<string, string>>
  /** Pull the record array out of the payload. Defaults to the payload itself. */
  select?: (payload: unknown) => readonly T[]
  /** Stable identity per record. Required: there is no file path to fall back on. */
  id: (record: T, index: number) => string
  /** Body text, for records carrying prose. */
  body?: (record: T) => string | undefined
  /** Shape the record. Defaults to the record as received. */
  data?: (record: T) => Record<string, unknown>
  /** Default `etag`. */
  revalidate?: Revalidate
  /** Behaviour when the request fails. Default `cache`. */
  onError?: RemoteErrorPolicy
  /** Injection point for tests and for custom transports. */
  fetch?: typeof globalThis.fetch
}

export class RemoteFetchError extends Error {
  override readonly name = 'RemoteFetchError'
  readonly hint: string
  constructor(message: string, hint: string) {
    super(message)
    this.hint = hint
  }
}

/**
 * Load records from an HTTP endpoint.
 *
 * Revalidation is keyed on the RESPONSE DIGEST rather than the etag: a server
 * that rotates etags without changing content would otherwise invalidate every
 * downstream document on every build.
 */
export function http<T = unknown>(options: HttpLoaderOptions<T>): Loader {
  const revalidate = options.revalidate ?? 'etag'
  const onError = options.onError ?? 'cache'

  return defineLoader({
    name: 'http',
    async load(ctx: LoaderContext): Promise<LoadResult> {
      const cached = ctx.snapshot()

      if (ctx.frozen) {
        // --frozen is the lockfile equivalent for content: never reach the
        // network, and fail rather than silently produce a different build.
        if (cached) return { records: cached, fromCache: true }
        throw new RemoteFetchError(
          `Collection "${ctx.collection}" has no cached data and --frozen forbids fetching`,
          'Run once without --frozen to populate the cache, and commit it if you need reproducible builds.'
        )
      }

      if (typeof revalidate === 'object' && cached && !ctx.forced) {
        const fetchedAt = Number(ctx.meta.get('fetchedAt') ?? 0)
        const age = (Date.now() - fetchedAt) / 1000
        if (Number.isFinite(age) && age < revalidate.seconds) {
          ctx.logger.debug(`${ctx.collection}: within revalidate window, using cache`)
          return { records: cached, fromCache: true }
        }
      }

      const doFetch = options.fetch ?? globalThis.fetch
      const url = typeof options.url === 'function' ? await options.url() : options.url
      const headers: Record<string, string> = { ...(await options.headers?.()) }

      if (revalidate === 'etag' && cached) {
        const etag = ctx.meta.get('etag')
        const lastModified = ctx.meta.get('lastModified')
        if (etag) headers['If-None-Match'] = etag
        if (lastModified) headers['If-Modified-Since'] = lastModified
      }

      let response: Response
      try {
        response = await doFetch(url, { headers, signal: ctx.signal })
      } catch (error) {
        return handleFailure(ctx, cached, onError, (error as Error).message)
      }

      // 304 costs one round trip and no parsing at all.
      if (response.status === 304 && cached) {
        ctx.logger.debug(`${ctx.collection}: not modified`)
        ctx.meta.set('fetchedAt', String(Date.now()))
        return { records: cached, fromCache: true }
      }

      if (!response.ok) {
        return handleFailure(ctx, cached, onError, `${response.status} ${response.statusText}`)
      }

      const text = await response.text()
      const digest = ctx.digest(text)

      // The digest, not the etag, decides whether anything changed.
      if (cached && digest === ctx.meta.get('digest')) {
        ctx.meta.set('fetchedAt', String(Date.now()))
        return { records: cached, fromCache: true }
      }

      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch (error) {
        return handleFailure(ctx, cached, onError, `invalid JSON: ${(error as Error).message}`)
      }

      const items = options.select ? options.select(payload) : (payload as readonly T[])
      if (!Array.isArray(items)) {
        return handleFailure(
          ctx,
          cached,
          onError,
          'expected an array of records; use `select` to point at one'
        )
      }

      const records: LoadedRecord[] = items.map((item, index) => {
        const id = options.id(item, index)
        const data = options.data ? options.data(item) : (item as Record<string, unknown>)
        const body = options.body?.(item)
        return {
          id,
          data,
          ...(body === undefined ? {} : { body }),
          digest: ctx.digest(JSON.stringify({ id, data, body }))
        }
      })

      const etag = response.headers.get('etag')
      const lastModified = response.headers.get('last-modified')
      if (etag) ctx.meta.set('etag', etag)
      if (lastModified) ctx.meta.set('lastModified', lastModified)
      ctx.meta.set('digest', digest)
      ctx.meta.set('fetchedAt', String(Date.now()))
      ctx.save(records)

      return { records, fromCache: false }
    }
  })
}

function handleFailure(
  ctx: LoaderContext,
  cached: LoadedRecord[] | undefined,
  policy: RemoteErrorPolicy,
  reason: string
): LoadResult {
  if (policy === 'fail') {
    throw new RemoteFetchError(
      `Collection "${ctx.collection}" could not be fetched: ${reason}`,
      'Set `onError: "cache"` to fall back to the last successful fetch, or "empty" to continue with no records.'
    )
  }
  if (policy === 'empty') {
    ctx.logger.warn(`${ctx.collection}: fetch failed (${reason}); continuing with no records`)
    return { records: [], fromCache: false }
  }
  if (cached) {
    // Loud, because a build that quietly serves yesterday's content is how a
    // stale deploy goes unnoticed.
    ctx.logger.warn(`${ctx.collection}: fetch failed (${reason}); using the last successful fetch`)
    return { records: cached, fromCache: true }
  }
  throw new RemoteFetchError(
    `Collection "${ctx.collection}" could not be fetched and has no cached data: ${reason}`,
    'The first build of a remote collection needs the network. Set `onError: "empty"` to allow an empty first build.'
  )
}
