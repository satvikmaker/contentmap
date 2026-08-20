import { createBuilder, type BuildResult, type BuilderOptions } from 'contentmap'

export interface NextPluginOptions extends BuilderOptions {
  /** Watch during `next dev`. Default true. */
  watch?: boolean
  /** Print a line per build. Default true. */
  logging?: boolean
}

/** Whatever shape the user's next.config exports. */
export type NextConfigLike = Record<string, unknown>

/**
 * Module-scoped, so the guard survives Next re-importing this module.
 *
 * `next dev` forks a child that re-evaluates next.config, and webpack builds
 * evaluate it once per compiler (node, edge, client). Without a guard the
 * content build runs three times for one command.
 */
const started = new Map<string, Promise<BuildResult>>()

/**
 * Run contentmap alongside Next.
 *
 * A config wrapper rather than a bundler plugin, and that is the whole design.
 * Next 16 makes Turbopack the default, Turbopack supports no webpack plugins,
 * and `webpack()` in next.config now hard-fails there. Doing the work while the
 * config module evaluates means Turbopack, webpack and whatever replaces them
 * all behave identically, because none of them are involved.
 *
 * Generated output resolves through `tsconfig.json` `paths`, which Turbopack
 * reads. That is the only resolution mechanism common to every Next bundler.
 *
 * Returns a thenable: `await`ing it blocks until the first build has been
 * written, while spreading or enumerating it sees a plain config.
 */
export function withContentmap(
  nextConfig: NextConfigLike = {},
  options: NextPluginOptions = {}
): NextConfigLike & PromiseLike<NextConfigLike> {
  const { watch = true, logging = true, ...builderOptions } = options
  const key = builderOptions.config ?? builderOptions.root ?? process.cwd()

  const ready = shouldRun()
    ? (started.get(key) ??
      (() => {
        const promise = run(builderOptions, { watch, logging })
        started.set(key, promise)
        return promise
      })())
    : Promise.resolve(undefined)

  // Non-enumerable: `Object.keys`, spreads and JSON see an ordinary config,
  // while Next — which awaits the config — waits for generation to finish.
  // An enumerable `then` would make the config itself look like a promise to
  // every other consumer.
  return Object.defineProperty({ ...nextConfig }, 'then', {
    enumerable: false,
    configurable: true,
    writable: true,
    value(
      onFulfilled?: (value: NextConfigLike) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) {
      return Promise.resolve(ready)
        .then(() => {
          const { then: _then, ...clean } = { ...nextConfig } as Record<string, unknown>
          return clean
        })
        .then(onFulfilled, onRejected)
    }
  }) as NextConfigLike & PromiseLike<NextConfigLike>
}

/**
 * Should this process build?
 *
 * Deliberately NOT by looking for `dev` in argv. Next 16 runs `next dev` by
 * forking `next-start`, which never sees the original arguments — the recipe
 * velite documents is broken there for exactly this reason.
 *
 * `next start` serves an existing build and must not rebuild. A child whose
 * parent has already exited (ppid 1) is the orphan Next leaves behind, and
 * would otherwise build a second time.
 */
function shouldRun(): boolean {
  const command = process.argv.slice(2).find(arg => !arg.startsWith('-'))
  if (command === 'start') return false
  const isDev = process.env['NODE_ENV'] === 'development'
  if (isDev && process.ppid === 1) return false
  return true
}

async function run(
  builderOptions: BuilderOptions,
  { watch, logging }: { watch: boolean; logging: boolean }
): Promise<BuildResult> {
  const builder = createBuilder(builderOptions)
  if (logging) {
    builder.on(event => {
      if (event.type === 'build:end' && event.result.errors === 0) {
        process.stderr.write(
          `contentmap: ${event.result.documents} document(s) in ${Math.round(event.result.durationMs)}ms\n`
        )
      }
    })
  }

  const result = await builder.build()

  if (watch && process.env['NODE_ENV'] === 'development') {
    await builder.watch()
    const stop = () => void builder.close()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  } else {
    await builder.close()
  }
  return result
}

export default withContentmap
