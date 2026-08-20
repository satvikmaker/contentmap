import { createBuilder, type AnyDocument, type BuilderOptions } from 'contentmap'

/** The slice of Astro's loader context this loader uses. */
export interface AstroLoaderContext {
  collection: string
  /** Present when Astro is refreshing on demand rather than syncing. */
  refreshContextData?: Record<string, unknown>
  store: {
    clear(): void
    set(entry: { id: string; data: Record<string, unknown>; body?: string; digest?: string }): void
  }
  logger: { info(msg: string): void; warn(msg: string): void }
  parseData(input: { id: string; data: Record<string, unknown> }): Promise<Record<string, unknown>>
  generateDigest(data: Record<string, unknown> | string): string
  watcher?: { on(event: string, cb: (path: string) => void): void }
}

export interface AstroLoaderOptions extends BuilderOptions {
  /** contentmap collection to expose. Defaults to the Astro collection's name. */
  collection?: string
}

interface Session {
  builder: ReturnType<typeof createBuilder>
  build: Promise<void>
  builds: number
}

/**
 * Shared across loader instances, keyed by config path.
 *
 * Astro calls `load()` once per collection, and a project declares one loader
 * per collection, so each gets its own instance. Building inside each of them
 * means N full builds of the whole project for N collections.
 */
const sessions = new Map<string, Session>()

/** Builds performed for a config path. Exposed for tests and diagnostics. */
export function buildCountFor(configPath: string): number {
  return sessions.get(configPath)?.builds ?? 0
}

/**
 * Expose a contentmap collection to Astro's content layer.
 *
 * A loader rather than a parallel pipeline, deliberately. Astro already owns
 * storage, `getCollection()`, HMR and type emission, and its loader contract is
 * the best design in this space. Reimplementing any of it would mean two
 * sources of truth inside one project.
 */
export interface ContentmapAstroLoader {
  name: string
  /** Builds performed for this loader's config path. */
  readonly buildCount: number
  load(context: AstroLoaderContext): Promise<void>
}

export function contentmapLoader(options: AstroLoaderOptions = {}): ContentmapAstroLoader {
  const { collection: collectionName, ...builderOptions } = options
  const loader = {
    name: 'contentmap',
    /** Builds this loader's config path has performed. */
    get buildCount(): number {
      return key === undefined ? 0 : buildCountFor(key)
    },
    async load(context: AstroLoaderContext): Promise<void> {
      const name = collectionName ?? context.collection
      const session = await acquire(builderOptions, Boolean(context.refreshContextData))

      const result = await session.build.then(() => session.last!)
      for (const diagnostic of result.diagnostics) {
        if (diagnostic.severity === 'error') {
          context.logger.warn(`${diagnostic.file ?? ''} ${diagnostic.message}`.trim())
        }
      }

      const documents = session.builder.documentsOf(name)
      if (documents.length === 0 && !session.builder.collectionNames().includes(name)) {
        throw new Error(
          `contentmap: no collection named "${name}". Known: ${session.builder.collectionNames().join(', ') || '(none)'}`
        )
      }
      context.store.clear()
      for (const doc of documents as AnyDocument[]) {
        const meta = doc['_meta'] as { id: string } | undefined
        const id = meta?.id ?? String(doc['id'] ?? '')
        const data = await context.parseData({ id, data: doc })
        context.store.set({ id, data, digest: context.generateDigest(doc) })
      }
      context.logger.info(`contentmap: ${documents.length} document(s) in "${name}"`)
    }
  }

  let key: string | undefined

  /**
   * One build per sync, shared by every collection.
   *
   * An explicit refresh — Astro passing `refreshContextData` — starts a new
   * one, because that is the caller saying the content has moved.
   */
  async function acquire(
    builderOptions: BuilderOptions,
    refresh: boolean
  ): Promise<Session & { last?: Awaited<ReturnType<ReturnType<typeof createBuilder>['build']>> }> {
    const probe = createBuilder(builderOptions)
    const configPath = (await probe.resolve()).configPath
    key = configPath

    const existing = sessions.get(configPath) as
      | (Session & { last?: Awaited<ReturnType<ReturnType<typeof createBuilder>['build']>> })
      | undefined

    if (existing && !refresh) {
      await probe.close()
      return existing
    }

    const builder = existing?.builder ?? probe
    if (existing) await probe.close()

    const session = {
      builder,
      builds: (existing?.builds ?? 0) + 1,
      last: undefined as never,
      build: Promise.resolve()
    } as Session & { last?: Awaited<ReturnType<ReturnType<typeof createBuilder>['build']>> }

    session.build = builder.build().then(result => {
      session.last = result
    })
    sessions.set(configPath, session)
    await session.build
    return session
  }

  return loader
}

export default contentmapLoader
