import { resolve } from 'node:path'
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

    // Register the alias, as the Vite plugin and the Nuxt module do. webpack
    // does not read tsconfig paths, so without this every project has to
    // repeat the same resolve.alias entry by hand — and `contentmap/generated`
    // looks enough like a real package subpath that the failure is "Module not
    // found", which points at nothing. Set before the build so the very first
    // compilation can resolve it.
    if (compiler.options) {
      const resolve = (compiler.options.resolve ??= {})
      const alias = (resolve.alias ??= {})
      alias['contentmap/generated'] ??= resolveGeneratedDir(builderOptions)
    }

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

/**
 * Where the generated output will land, without resolving the config.
 *
 * `apply()` is synchronous, and reading the config is not, so this mirrors the
 * same defaulting the resolver uses. An explicit `outDir` wins; otherwise it is
 * `.contentmap` under the project root, which is the default the CLI, the
 * scaffolder and the tsconfig path all already assume.
 */
function resolveGeneratedDir(options: BuilderOptions): string {
  return resolve(options.root ?? process.cwd(), options.outDir ?? '.contentmap')
}

export default ContentmapWebpackPlugin
