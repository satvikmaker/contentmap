import { createBuilder, type Builder, type BuilderOptions } from 'contentmap'

/**
 * Structural types for the Nuxt objects used here.
 *
 * Nuxt is an optional peer, so this module installs without pulling a major.
 */
interface NuxtLike {
  options: {
    rootDir: string
    alias: Record<string, string>
    /** True during `nuxt prepare`: generate types, build nothing. */
    _prepare?: boolean
    nitro: {
      typescript?: { tsConfig?: { include?: string[]; compilerOptions?: { paths?: Record<string, string[]> } } }
    }
    typescript?: { tsConfig?: { compilerOptions?: { paths?: Record<string, string[]> } } }
  }
  hook(name: string, cb: (...args: never[]) => unknown): void
  callHook?(name: string, ...args: unknown[]): Promise<void>
}

export interface NuxtModuleOptions extends BuilderOptions {
  /** Watch in dev. Default true. */
  watch?: boolean
}

/**
 * Nuxt module for contentmap.
 *
 * Nuxt needs a module rather than a bare Vite plugin: a plugin gets no access
 * to the virtual filesystem, no way to register types, and no path into Nitro.
 * Nothing else in this space supports Nuxt at all — the request has been open
 * on content-collections since January 2024.
 */
export function contentmapModule(options: NuxtModuleOptions = {}) {
  return {
    meta: { name: 'contentmap', configKey: 'contentmap' },
    async setup(_moduleOptions: unknown, nuxt: NuxtLike): Promise<void> {
      const { watch = true, ...builderOptions } = options
      const builder: Builder = createBuilder({ root: nuxt.options.rootDir, ...builderOptions })
      const config = await builder.resolve()
      const generated = config.output.dir

      nuxt.options.alias['contentmap/generated'] = generated

      // Nitro type-checks separately from the app, so registering the path in
      // the Nuxt tsconfig alone leaves server routes unable to resolve it.
      const paths = { 'contentmap/generated': [generated] }
      const app = (nuxt.options.typescript ??= {})
      const appTs = (app.tsConfig ??= {})
      const appCompiler = (appTs.compilerOptions ??= {})
      appCompiler.paths = { ...appCompiler.paths, ...paths }

      const nitroTs = (nuxt.options.nitro.typescript ??= {})
      const nitroConfig = (nitroTs.tsConfig ??= {})
      const nitroCompiler = (nitroConfig.compilerOptions ??= {})
      nitroCompiler.paths = { ...nitroCompiler.paths, ...paths }

      await builder.build()

      // `nuxt prepare` exists to produce types without building. Starting a
      // watcher there leaves the command hanging.
      if (nuxt.options._prepare) {
        await builder.close()
        return
      }

      if (watch) {
        nuxt.hook('close', (async () => {
          await builder.close()
        }) as never)
        await builder.watch()
      } else {
        await builder.close()
      }
    }
  }
}

export default contentmapModule
