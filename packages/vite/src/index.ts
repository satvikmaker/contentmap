import { fileURLToPath } from 'node:url'
import { createBuilder, type Builder, type BuilderOptions } from 'contentmap'

/**
 * Minimal structural types for the Vite objects we touch.
 *
 * Vite is an optional peer: this plugin should install without pulling a
 * particular major, and the surface used here has been stable across 5 to 8.
 */
interface ViteServerLike {
  watcher: { on(event: string, cb: (path: string) => void): void }
  environments?: Record<string, unknown>
  moduleGraph?: {
    getModuleById(id: string): unknown
    invalidateModule(mod: unknown, seen?: unknown, timestamp?: number, isHmr?: boolean): void
  }
  ws?: { send(payload: { type: string; path?: string }): void }
  hot?: { send(payload: { type: string; path?: string }): void }
  config?: { logger?: { info(msg: string): void } }
}

interface ResolvedViteConfig {
  root: string
  command: 'build' | 'serve'
  server?: { fs?: { allow?: string[] } }
}

export interface ContentmapPluginOptions extends BuilderOptions {
  /**
   * Decide whether this Vite instance should run the build.
   *
   * Meta-frameworks invoke Vite more than once — SvelteKit evaluates its config
   * twice, and every framework using Vite 6 environments has one instance per
   * environment. Returning false disables the build while keeping the alias, so
   * imports still resolve.
   */
  isEnabled?: (config: ResolvedViteConfig) => boolean
  /** Log a line per rebuild. Default true. */
  logging?: boolean
}

export interface VitePluginLike {
  name: string
  enforce?: 'pre' | 'post'
  sharedDuringBuild?: boolean
  config?: (config: unknown) => unknown
  configResolved?: (config: ResolvedViteConfig) => void | Promise<void>
  configureServer?: (server: ViteServerLike) => void | Promise<void>
  buildEnd?: () => void | Promise<void>
}

/**
 * Run contentmap from Vite.
 *
 * This plugin is a convenience, never a requirement: `contentmap build` produces
 * the same output, and CI diffs the two to keep that true. Contentlayer's only
 * working answer for Turbopack was running its CLI beside the dev server, and
 * that worked precisely because its CLI was independent.
 */
export function contentmap(options: ContentmapPluginOptions = {}): VitePluginLike {
  const { isEnabled, logging = true, ...builderOptions } = options
  let builder: Builder | undefined
  let generatedDir: string | undefined
  // One build per process, not per environment. Vite 6 runs a plugin instance
  // for each environment, and SvelteKit evaluates the whole config twice.
  let started: Promise<void> | undefined
  let enabled = true

  const plugin: VitePluginLike = {
    name: 'contentmap',
    enforce: 'pre',
    sharedDuringBuild: true,

    // `config` runs BEFORE `configResolved`, so the output directory has to be
    // discovered here. Returning an alias whose target is still undefined makes
    // Vite's alias plugin reject the whole config.
    async config(userConfig: unknown) {
      const root =
        builderOptions.root ??
        (userConfig as { root?: string } | undefined)?.root ??
        process.cwd()
      builder ??= createBuilder({ ...builderOptions, root })
      generatedDir = (await builder.resolve()).output.dir

      // Returned even when the build is disabled: a disabled instance still has
      // to resolve the generated module, or imports fail in that environment.
      //
      // The runtime is aliased too. Generated modules import it by bare
      // specifier, which relies on `contentmap` being resolvable from the
      // application — true for a normal install, but not under a strict pnpm
      // layout where the app depends on this plugin and only transitively on
      // the core. Pointing at the copy this plugin already resolved removes
      // that dependency on hoisting.
      const alias: Record<string, string> = { 'contentmap/generated': generatedDir }
      const runtime = resolveRuntime()
      if (runtime) alias['contentmap/runtime'] = runtime

      return {
        optimizeDeps: { exclude: ['contentmap/generated', 'contentmap/runtime'] },
        resolve: { alias }
      }
    },

    async configResolved(config: ResolvedViteConfig) {
      enabled = isEnabled ? isEnabled(config) : true
      builder ??= createBuilder({ root: config.root, ...builderOptions })
      generatedDir ??= (await builder.resolve()).output.dir

      // Patch, never replace. SvelteKit sets its own allow list, and
      // overwriting it makes the dev server return 403 for its own files.
      const fs = (config.server ??= {}).fs ??= {}
      if (Array.isArray(fs.allow) && !fs.allow.includes(generatedDir)) {
        fs.allow.push(generatedDir)
      }

      if (!enabled) return
      // configResolved, not buildStart: buildStart fires once per environment.
      started ??= builder.build().then(() => undefined)
      await started
    },

    async configureServer(server: ViteServerLike) {
      if (!enabled || !builder) return

      // Vite already watches the project. A second watcher doubles the handles
      // and delivers two events per edit.
      const handle = await builder.watch({
        watcher: server.watcher as never
      })

      builder.on(event => {
        if (event.type !== 'build:end') return
        if (logging && event.result.errors === 0) {
          server.config?.logger?.info(
            `contentmap: ${event.result.documents} document(s) in ${Math.round(event.result.durationMs)}ms`
          )
        }
        invalidate(server, generatedDir)
      })

      const stop = () => void handle.close()
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    },

    async buildEnd() {
      await builder?.close()
    }
  }
  return plugin
}

/**
 * Locate the runtime module this plugin's own `contentmap` resolves to.
 *
 * Returns undefined when it cannot be found, in which case the generated
 * module's bare import is left to the bundler — which is correct whenever the
 * application has `contentmap` installed directly.
 */
function resolveRuntime(): string | undefined {
  try {
    return fileURLToPath(import.meta.resolve('contentmap/runtime'))
  } catch {
    return undefined
  }
}

/**
 * Invalidate the generated module.
 *
 * Both graphs, deliberately. From Vite 6 the module runner keeps its own
 * evaluated-module cache, so clearing `moduleGraph` alone leaves the server
 * executing the previous version — Astro invalidates both for the same reason.
 */
function invalidate(server: ViteServerLike, generatedDir: string | undefined): void {
  if (!generatedDir) return
  const id = `${generatedDir}/index.js`
  const mod = server.moduleGraph?.getModuleById(id)
  if (mod) {
    server.moduleGraph?.invalidateModule(mod, undefined, Date.now(), true)
  }

  for (const environment of Object.values(server.environments ?? {})) {
    const runner = (environment as { runner?: { evaluatedModules?: {
      getModuleById(id: string): unknown
      invalidateModule(mod: unknown): void
    } } }).runner
    const evaluated = runner?.evaluatedModules
    const runnerModule = evaluated?.getModuleById(id)
    if (runnerModule) evaluated?.invalidateModule(runnerModule)
  }

  const send = server.hot?.send ?? server.ws?.send
  send?.call(server.hot ?? server.ws, { type: 'full-reload', path: '*' })
}

export default contentmap
