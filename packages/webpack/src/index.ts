import { createBuilder, type Builder, type BuilderOptions } from 'contentmap'

interface CompilerLike {
  options?: {
    mode?: string
    resolve?: { alias?: Record<string, string | false | string[]> }
  }
  hooks: {
    beforeCompile: { tapPromise(name: string, fn: () => Promise<void>): void }
    shutdown?: { tapPromise(name: string, fn: () => Promise<void>): void }
  }
}

export interface WebpackPluginOptions extends BuilderOptions {
  /** Watch in development. Default true. */
  watch?: boolean
}

/**
 * webpack and Rspack plugin for contentmap.
 *
 * Provided for projects still on webpack. It is strictly a convenience: the CLI
 * produces identical output, and relying on a bundler plugin is what left
 * contentlayer unable to run at all once Turbopack arrived.
 */
interface Session {
  started: Promise<void>
  builder: Builder
  /** Where the resolved config puts generated output. */
  generated?: string
}

export class ContentmapWebpackPlugin {
  /**
   * Shared across instances, keyed by project.
   *
   * A webpack build constructs one compiler per target — node, edge and client
   * — so a per-instance guard still builds three times for one command. Keyed
   * rather than global because one process can build more than one project: a
   * monorepo build script would otherwise have the second project silently
   * reuse the first one's builder, and its generated alias.
   */
  static #sessions = new Map<string, Session>()

  readonly #options: WebpackPluginOptions

  constructor(options: WebpackPluginOptions = {}) {
    this.#options = options
  }

  apply(compiler: CompilerLike): void {
    const { watch = true, ...builderOptions } = this.#options

    const key = sessionKey(builderOptions)

    compiler.hooks.beforeCompile.tapPromise('contentmap', async () => {
      let session = ContentmapWebpackPlugin.#sessions.get(key)
      if (!session) {
        const builder = createBuilder(builderOptions)
        const created: Session = {
          builder,
          started: Promise.resolve()
        }
        created.started = (async () => {
          // Ask the resolver where output actually goes rather than recomputing
          // the default. `output.dir` in the config, and a `root` relative to
          // the config rather than to cwd, both move it — and an alias pointing
          // at a directory that was never written fails as "Module not found",
          // naming nothing.
          created.generated = (await builder.resolve()).output.dir
          // Awaited, unlike contentlayer's fire-and-forget dev path, which is
          // why its first dev render could show stale or missing data.
          await builder.build()
          if (watch && compiler.options?.mode === 'development') await builder.watch()
        })()
        session = created
        ContentmapWebpackPlugin.#sessions.set(key, created)
      }
      await session.started

      // Register the alias, as the Vite plugin and the Nuxt module do. webpack
      // does not read tsconfig paths, so without this every project repeats the
      // same resolve.alias by hand. Set here rather than in `apply` because the
      // location is only known once the config has been read, and beforeCompile
      // still precedes any module resolution.
      if (compiler.options && session.generated !== undefined) {
        const resolve = (compiler.options.resolve ??= {})
        const alias = (resolve.alias ??= {})
        alias['contentmap/generated'] ??= session.generated
      }
    })

    compiler.hooks.shutdown?.tapPromise('contentmap', async () => {
      const session = ContentmapWebpackPlugin.#sessions.get(key)
      ContentmapWebpackPlugin.#sessions.delete(key)
      await session?.builder.close()
    })
  }
}

/**
 * Identity of the project a compiler is building.
 *
 * Only the fields that can point at different content; anything else is either
 * irrelevant to which builder to share, or already reflected in the config the
 * builder resolves.
 */
function sessionKey(options: BuilderOptions): string {
  return JSON.stringify([options.root ?? process.cwd(), options.config ?? '', options.outDir ?? ''])
}

export default ContentmapWebpackPlugin
