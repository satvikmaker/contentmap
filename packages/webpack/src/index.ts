import { createBuilder, type Builder, type BuilderOptions } from 'contentmap'

interface CompilerLike {
  options?: { mode?: string }
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
export class ContentmapWebpackPlugin {
  /**
   * Shared across instances on purpose.
   *
   * A webpack build constructs one compiler per target — node, edge and client
   * — so a per-instance guard still builds three times for one command.
   */
  static #started: Promise<void> | undefined
  static #builder: Builder | undefined

  readonly #options: WebpackPluginOptions

  constructor(options: WebpackPluginOptions = {}) {
    this.#options = options
  }

  apply(compiler: CompilerLike): void {
    const { watch = true, ...builderOptions } = this.#options

    compiler.hooks.beforeCompile.tapPromise('contentmap', async () => {
      ContentmapWebpackPlugin.#started ??= (async () => {
        const builder = createBuilder(builderOptions)
        ContentmapWebpackPlugin.#builder = builder
        // Awaited, unlike contentlayer's fire-and-forget dev path, which is why
        // its first dev render could show stale or missing data.
        await builder.build()
        if (watch && compiler.options?.mode === 'development') await builder.watch()
      })()
      await ContentmapWebpackPlugin.#started
    })

    compiler.hooks.shutdown?.tapPromise('contentmap', async () => {
      await ContentmapWebpackPlugin.#builder?.close()
      ContentmapWebpackPlugin.#builder = undefined
      ContentmapWebpackPlugin.#started = undefined
    })
  }
}

export default ContentmapWebpackPlugin
