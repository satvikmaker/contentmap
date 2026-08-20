import { createBuilder, type BuilderOptions } from 'contentmap'

/** The slice of Astro's loader context this loader uses. */
interface AstroLoaderContext {
  collection: string
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

/**
 * Expose a contentmap collection to Astro's content layer.
 *
 * A loader rather than a parallel pipeline, deliberately. Astro already owns
 * storage, `getCollection()`, HMR and type emission, and its loader contract is
 * the best design in this space. Reimplementing any of it would mean two
 * sources of truth inside one project.
 */
export function contentmapLoader(options: AstroLoaderOptions = {}) {
  const { collection: collectionName, ...builderOptions } = options
  return {
    name: 'contentmap',
    async load(context: AstroLoaderContext): Promise<void> {
      const builder = createBuilder(builderOptions)
      const name = collectionName ?? context.collection
      try {
        const result = await builder.build()
        for (const diagnostic of result.diagnostics) {
          if (diagnostic.severity === 'error') {
            context.logger.warn(`${diagnostic.file ?? ''} ${diagnostic.message}`.trim())
          }
        }

        const documents = await readCollection(builder, name)
        context.store.clear()
        for (const doc of documents) {
          const meta = doc['_meta'] as { id: string } | undefined
          const id = meta?.id ?? String(doc['id'] ?? '')
          const data = await context.parseData({ id, data: doc })
          context.store.set({ id, data, digest: context.generateDigest(doc) })
        }
        context.logger.info(`contentmap: ${documents.length} document(s) in "${name}"`)
      } finally {
        await builder.close()
      }
    }
  }
}

/**
 * Read a built collection back out of the generated output.
 *
 * Via the emitted module rather than internal state, so this loader consumes
 * exactly what every other consumer does.
 */
async function readCollection(
  builder: ReturnType<typeof createBuilder>,
  name: string
): Promise<Record<string, unknown>[]> {
  const config = await builder.resolve()
  const url = `${config.output.dir}/${name}/index.js`
  const mod: Record<string, unknown> = await import(
    /* @vite-ignore */ `${pathToFileUrl(url)}?t=${Date.now()}`
  )
  const query = (mod[name] ?? mod['default']) as
    | { all(): Record<string, unknown>[] }
    | Record<string, unknown>[]
    | undefined
  if (!query) throw new Error(`contentmap: collection "${name}" is not in the generated output`)
  return Array.isArray(query) ? query : query.all()
}

function pathToFileUrl(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`
}

export default contentmapLoader
