import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import { dirname, relative, resolve, sep } from 'node:path'
import type { BuildResult, Logger, ResolvedConfig } from '../types.ts'

export interface WatchHooks {
  /** Rebuild. `changed` is empty for a full rebuild. */
  rebuild(changed: ReadonlySet<string>, reason: string): Promise<BuildResult>
  /** Reload the config and rebuild everything. */
  reload(path: string): Promise<BuildResult | undefined>
  logger: Logger
}

export interface WatchOptions {
  /**
   * A watcher supplied by the host, when one exists.
   *
   * Vite and Nuxt already run a watcher over the project; adding a second one
   * doubles the inotify handles and produces two events per edit. Astro and
   * fumadocs both take the host's, and so do we.
   */
  watcher?: FSWatcher
  /** Trailing-edge debounce, in milliseconds. */
  debounce?: number
  signal?: AbortSignal
}

export interface WatchHandle {
  close(): Promise<void>
  /** Paths currently watched, for diagnostics and tests. */
  readonly paths: readonly string[]
}

/**
 * Watch content and rebuild.
 *
 * Two properties matter more than anything else here.
 *
 * Events are debounced on the trailing edge, so a burst of writes — an editor
 * saving, a `git checkout`, a formatter sweeping a directory — becomes one
 * rebuild rather than one per file.
 *
 * At most one build runs at a time, with a single pending slot. Content
 * Collections has neither: ten rapid writes there produced ten concurrent
 * builds, all writing the same output files. Coalescing means the queue can
 * never grow beyond "something changed while we were busy", which is all the
 * information a rebuild needs.
 */
export async function startWatch(
  config: ResolvedConfig,
  hooks: WatchHooks,
  options: WatchOptions = {}
): Promise<WatchHandle> {
  const debounceMs = options.debounce ?? 50
  const owned = options.watcher === undefined

  const watchPaths = collectWatchPaths(config)
  const watcher =
    options.watcher ??
    chokidarWatch(watchPaths, {
      ignoreInitial: true,
      ignored: (path: string) => isIgnored(path, config)
    })
  if (options.watcher) watcher.add(watchPaths)

  // Wait for the initial scan before returning.
  //
  // chokidar reports nothing until it has walked the tree, so resolving early
  // means an edit made right after `watch()` is silently dropped — the caller
  // believes it is watching when it is not yet. Only meaningful for a watcher
  // we created; a host's is already running.
  if (owned) {
    await new Promise<void>((resolveReady, rejectReady) => {
      const onReady = (): void => {
        watcher.off('error', onError)
        resolveReady()
      }
      const onError = (error: unknown): void => {
        watcher.off('ready', onReady)
        rejectReady(error instanceof Error ? error : new Error(String(error)))
      }
      watcher.once('ready', onReady)
      watcher.once('error', onError)
    })
  }

  let pendingPaths = new Set<string>()
  let pendingConfig: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | undefined
  let queued = false
  let closed = false

  const flush = async (): Promise<void> => {
    if (closed) return
    if (running) {
      // One pending slot. Anything arriving while a build runs is captured by
      // the accumulating sets, so a second queue entry would add nothing.
      queued = true
      return
    }
    running = (async () => {
      do {
        queued = false
        const changed = pendingPaths
        const configPath = pendingConfig
        pendingPaths = new Set()
        pendingConfig = undefined

        try {
          if (configPath) {
            hooks.logger.info('config changed, reloading')
            await hooks.reload(configPath)
          } else if (changed.size > 0) {
            await hooks.rebuild(changed, describe(changed))
          }
        } catch (error) {
          // A failed rebuild must not stop the watcher; the next save is
          // usually the fix.
          hooks.logger.warn(`rebuild failed: ${(error as Error).message}`)
        }
      } while (queued && !closed)
    })()
    try {
      await running
    } finally {
      running = undefined
    }
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, debounceMs)
  }

  const onEvent = (event: string, path: string): void => {
    if (closed) return
    if (event === 'addDir' || event === 'unlinkDir') return
    const absolute = resolve(path)
    if (isIgnored(absolute, config)) return

    if (isConfigPath(absolute, config)) pendingConfig = absolute
    else pendingPaths.add(absolute)
    schedule()
  }

  watcher.on('all', onEvent)

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    watcher.off('all', onEvent)
    // Wait for work already in flight.
    //
    // Returning while a rebuild is still writing means the caller's next move —
    // deleting a temp directory, swapping a deployment — races with our own
    // output. `closed` stops the loop from starting another pass.
    if (running) await running.catch(() => undefined)
    // Only close a watcher we created. Closing the host's would take its dev
    // server down with it.
    if (owned) await watcher.close()
  }

  options.signal?.addEventListener('abort', () => void close(), { once: true })

  return { close, paths: watchPaths }
}

function collectWatchPaths(config: ResolvedConfig): string[] {
  const paths = new Set<string>([config.configPath])
  for (const dep of config.configDeps) paths.add(dep)
  for (const collection of Object.values(config.collections)) {
    if (collection.directory) paths.add(collection.directory)
  }
  return [...paths].sort()
}

function isConfigPath(path: string, config: ResolvedConfig): boolean {
  return path === config.configPath || config.configDeps.includes(path)
}

/**
 * Never watch our own output.
 *
 * A build writes into the output directory, which would fire the watcher,
 * which would rebuild, which would write again.
 */
function isIgnored(path: string, config: ResolvedConfig): boolean {
  const absolute = resolve(path)
  if (isWithin(config.output.dir, absolute)) return true
  if (isWithin(config.output.assets, absolute)) return true

  const rel = relative(config.root, absolute)
  if (rel.startsWith('..')) return false
  return rel
    .split(sep)
    .some(segment => segment === 'node_modules' || (segment.startsWith('.') && segment !== '.'))
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep))
}

function describe(changed: ReadonlySet<string>): string {
  const [first] = changed
  if (changed.size === 1 && first) return first
  return `${changed.size} files`
}

export { dirname }
