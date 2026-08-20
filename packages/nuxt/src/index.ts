import { createBuilder, type Builder, type BuilderOptions } from 'contentmap'

/**
 * Structural types for the Nuxt objects used here.
 *
 * Nuxt is an optional peer, so this module installs without pulling a major.
 */
export interface NuxtLike {
  options: {
    rootDir: string
    alias: Record<string, string>
    /** True during `nuxt prepare`: generate types, build nothing. */
    _prepare?: boolean
    nitro: {
      typescript?: {
        tsConfig?: { include?: string[]; compilerOptions?: { paths?: Record<string, string[]> } }
      }
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
/** Module metadata, in the shape `@nuxt/kit` produces. */
export interface ModuleMeta {
  name: string
  configKey: string
}

/**
 * Nuxt requires a module to be a *function*, and rejects a plain object with
 * "The Nuxt module @contentmap/nuxt is not a function". `setup` and `meta` stay
 * on it so the module can also be driven directly.
 */
export interface ContentmapNuxtModule {
  (inlineOptions: NuxtModuleOptions | undefined, nuxt: NuxtLike): Promise<void>
  getMeta(): ModuleMeta
  meta: ModuleMeta
  setup(moduleOptions: NuxtModuleOptions | undefined, nuxt: NuxtLike): Promise<void>
}

export function contentmapModule(options: NuxtModuleOptions = {}): ContentmapNuxtModule {
  const meta: ModuleMeta = { name: 'contentmap', configKey: 'contentmap' }
  const self = ((inlineOptions, nuxt) => self.setup(inlineOptions, nuxt)) as ContentmapNuxtModule
  self.meta = meta
  self.getMeta = () => meta
  Object.assign(self, {
    meta,
    async setup(moduleOptions: NuxtModuleOptions | undefined, nuxt: NuxtLike): Promise<void> {
      // The configKey is only read for us by `defineNuxtModule`, and depending
      // on @nuxt/kit for that would put a framework in the dependency tree of
      // a package whose whole argument is not needing one. Precedence runs
      // config key, then inline options, then the factory argument — each more
      // specific than the last.
      // Cast at the one site that needs it. An index signature on NuxtLike
      // would silence typos in every other `nuxt.options.x` we touch.
      const fromConfigKey = ((nuxt.options as Record<string, unknown>)[meta.configKey] ??
        {}) as NuxtModuleOptions
      const { watch = true, ...builderOptions } = { ...fromConfigKey, ...moduleOptions, ...options }
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
  })
  return self
}

/**
 * The default export has to BE the module, not a factory that returns one.
 *
 * `modules: ['@contentmap/nuxt']` makes Nuxt import this and use it directly.
 * When it was `contentmapModule` itself, Nuxt called it as the module — with
 * `(inlineOptions, nuxt)` — took the object it returned, and discarded it, so
 * `setup` never ran: no content built, no alias registered, and a build that
 * failed on an unresolvable import rather than on anything that named the
 * cause. Every unit test passed, because they call `contentmapModule().setup()`
 * by hand. Only a real `nuxt build` exercises the registration path.
 *
 * `modules: [contentmapModule({ ... })]` still works for passing options in
 * code rather than through the `contentmap` config key.
 */
const module: ContentmapNuxtModule = contentmapModule()
export default module
