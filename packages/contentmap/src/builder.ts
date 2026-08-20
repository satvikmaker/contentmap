import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  codeFrame,
  DiagnosticBag,
  findKeyPosition,
  normalizeParserError
} from './diagnostics/index.ts'
import { resolveConfig } from './config/resolve.ts'
import { collectFiles, metaFor, type PreviousState, type SourceFile } from './collect/read.ts'
import { resolveParser } from './parsers/index.ts'
import { validate } from './validate/standard.ts'
import { createTransformContext, isSkipSignal } from './render/index.ts'
import {
  AssetStore,
  isImageExtension,
  isRelativeUrl,
  rewriteHtml,
  splitUrl,
  type ResolvedAsset
} from './assets/index.ts'
import {
  cleanOutput,
  createEmitStats,
  emitBarrel,
  emitCollection,
  emitTypes,
  type EmitStats
} from './write/emit.ts'
import { withFdRetry } from './utils/fd.ts'
import { mapLimit } from './utils/limit.ts'
import { cacheKey, digest as digestOf, stableStringify } from './utils/digest.ts'
import { TransformCache } from './cache/index.ts'
import { RemoteStore } from './loaders/meta.ts'
import type { LoadedRecord, LoaderContext } from './loaders/types.ts'
import { redactSecrets } from './security/secrets.ts'
import { suggest, toPosix } from './utils/paths.ts'
import { startWatch, type WatchHandle, type WatchOptions } from './watch/index.ts'
/** Field the frontmatter parsers write the document body into. */
const BODY_FIELD = 'content'

interface ParsedDocument {
  id: string
  meta: DocumentMeta
  validated: Record<string, unknown>
  body: string
}

interface CollectionResult {
  entries: StoreEntry[]
  cacheHits: number
}

/** Two collections whose transforms demand each other. */
export class ReferenceCycleError extends Error {
  override readonly name = 'ReferenceCycleError'
  readonly hint: string
  readonly chain: readonly string[]
  constructor(chain: readonly string[]) {
    super(`Reference cycle between collections: ${chain.join(' -> ')}`)
    this.chain = chain
    this.hint =
      'One of these transforms must stop reading the other. Use `reference()` to keep an id instead of embedding the document.'
  }
}

export class UnknownCollectionError extends Error {
  override readonly name = 'UnknownCollectionError'
  readonly hint: string
  constructor(name: string, known: readonly string[]) {
    super(`Unknown collection "${name}"`)
    const guess = suggest(name, known)
    this.hint = guess
      ? `Did you mean "${guess}"?`
      : `Known collections: ${known.join(', ') || '(none)'}`
  }
}

import type { ContextServices } from './render/context.ts'
import type {
  BuildOptions,
  RefreshOptions,
  AnyDocument,
  CollectionRef,
  BuilderEvent,
  BuilderOptions,
  BuildResult,
  CollectionDefinition,
  Diagnostic,
  DocumentMeta,
  Image,
  Logger,
  ResolvedConfig,
  Severity,
  StoreEntry
} from './types.ts'

type Listener = (event: BuilderEvent) => void

/**
 * Orchestrates a build.
 *
 * `createBuilder` performs NO io — nothing is globbed, read, parsed or reported
 * until `build()`. Together with the replay buffer below, that closes the hole
 * that let content-collections lose 2,758 of 3,000 documents while exiting 0:
 * it collects inside its constructor, so every read error is emitted before a
 * caller can possibly subscribe.
 */
export class Builder {
  #options: BuilderOptions
  #listeners = new Set<Listener>()
  #buffer: BuilderEvent[] = []
  #config: ResolvedConfig | undefined
  #previous = new Map<string, Map<string, PreviousState>>()
  #cache = new Map<string, StoreEntry[]>()
  #emitStats: EmitStats | undefined
  #assets = new AssetStore()
  #transformCache: TransformCache | undefined
  /** Collections finished this build. */
  #built = new Map<string, CollectionResult>()
  /** Collections currently building, so concurrent demands share one build. */
  #inFlight = new Map<string, Promise<CollectionResult>>()
  #scanned = 0
  /** Absolute path -> collections whose documents asked to watch it. */
  #extraWatched = new Map<string, Set<string>>()
  /** Per-document reference and watch records, harvested after each transform. */
  #refsFor = new Map<string, { collection: string; id: string; digest: string }[]>()
  #watchFor = new Map<string, string[]>()
  /** Per-build memo of every validated document in a collection, for siblings(). */
  #validated = new Map<string, Promise<AnyDocument[]>>()
  #remote!: RemoteStore
  /** Records the loader produced this build, so siblings() can use them. */
  #loaded = new Map<string, LoadedRecord[]>()
  /** Paths the watcher reported this build; undefined means "discover". */
  #changedPaths: ReadonlySet<string> | undefined
  /** Collections to refetch regardless of their revalidate window. */
  #forced: ReadonlySet<string> | undefined
  #refreshContext: Record<string, unknown> | undefined
  #watchHandle: WatchHandle | undefined
  /** Aborted on close; replaced per build so a closed builder can be reused. */
  #abort = new AbortController()
  #logger: Logger = {
    info: message => this.#emit({ type: 'log', level: 'info', message }),
    warn: message => this.#emit({ type: 'log', level: 'warn', message }),
    debug: message => this.#emit({ type: 'log', level: 'debug', message })
  }

  constructor(options: BuilderOptions = {}) {
    this.#options = options
  }

  /** Late subscribers receive everything emitted so far, in order. */
  on(listener: Listener): () => void {
    for (const event of this.#buffer) listener(event)
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(event: BuilderEvent): void {
    this.#buffer.push(event)
    for (const listener of this.#listeners) listener(event)
  }

  get config(): ResolvedConfig | undefined {
    return this.#config
  }

  async resolve(): Promise<ResolvedConfig> {
    const config = await resolveConfig(this.#options)
    this.#config = config
    this.#emit({ type: 'config:loaded', path: config.configPath })
    return config
  }

  /**
   * Cumulative wall clock per pipeline stage, surfaced by `--verbose`.
   *
   * Deliberately leaves only — config, read, load, parse, validate, transform,
   * emit. Timing an envelope *and* its contents produces a table where the
   * biggest number is an alias for several of the others, which reads as a
   * finding and is really an artefact.
   */
  readonly phases: Record<string, number> = {}

  // Promisable, not Promise: a parser is free to be synchronous, and the
  // timing wrapper must not be what forces it onto the microtask queue.
  #time<T>(phase: string, fn: () => T | Promise<T>): Promise<T> {
    const t = performance.now()
    return Promise.resolve(fn()).finally(() => {
      this.phases[phase] = (this.phases[phase] ?? 0) + (performance.now() - t)
    })
  }

  async build(options: BuildOptions = {}): Promise<BuildResult> {
    const started = performance.now()
    // Relative paths from the watcher are matched per collection, so store
    // them absolute and narrow later.
    this.#changedPaths = options.changed
    this.#forced = options.forceLoaders
    this.#refreshContext = options.refreshContext
    // A previous close() aborted the last signal; loaders in this build must
    // not inherit it.
    if (this.#abort.signal.aborted) this.#abort = new AbortController()
    for (const k of Object.keys(this.phases)) delete this.phases[k]
    this.#scanned = 0
    this.#assets.reset()
    this.#built.clear()
    this.#inFlight.clear()
    this.#validated.clear()
    this.#loaded.clear()
    this.#emit({ type: 'build:start' })

    const config = this.#config ?? (await this.#time('config', () => this.resolve()))
    const diagnostics = new DiagnosticBag()

    this.#transformCache ??= new TransformCache(
      join(config.output.cacheDir, 'transforms'),
      config.configDigest
    )
    this.#transformCache.reset()
    this.#remote ??= new RemoteStore(join(config.output.cacheDir, 'remote'))

    if (config.output.clean) await cleanOutput(config)

    let documents = 0
    let cacheHits = 0
    this.#emitStats ??= createEmitStats(config.dryRun)
    const stats: EmitStats = this.#emitStats

    // Build every collection, resolving cross-collection references on demand.
    // Declaration order is irrelevant: a transform asking for another
    // collection triggers that collection's build, so the effective order is
    // topological. content-collections instead mutates a shared array inside a
    // sequential loop, which is why reordering their config silently changes
    // what `documents()` returns (their issue #396).
    for (const name of Object.keys(config.collections)) {
      await this.#ensureBuilt(name, config, diagnostics, [])
    }

    for (const [name, collection] of Object.entries(config.collections)) {
      const result = this.#built.get(name)
      if (!result) continue
      documents += result.entries.length
      cacheHits += result.cacheHits
      await this.#time('emit', () =>
        emitCollection({ collection, entries: result.entries, config, stats, diagnostics })
      )
    }

    // One copy pass at the end: a file referenced by fifty documents is read,
    // hashed and written exactly once.
    await this.#assets.flush(
      config.output.assets,
      join(config.output.cacheDir, 'assets.json'),
      config.dryRun
    )

    // Collections that disappeared from the config must not leave caches behind.
    const names = Object.keys(config.collections)
    await this.#transformCache?.pruneTo(names, config.dryRun)
    await this.#remote?.pruneTo(names, config.dryRun)
    await this.#transformCache?.flush(config.dryRun)
    await this.#remote?.flush(config.dryRun)

    await emitBarrel(config, stats)
    await emitTypes(config, stats)

    for (const d of diagnostics.items) this.#emit({ type: 'diagnostic', diagnostic: d })

    const result: BuildResult = {
      collections: Object.keys(config.collections).length,
      documents,
      scanned: Math.max(this.#scanned, documents),
      errors: diagnostics.errors,
      warnings: diagnostics.warnings,
      durationMs: performance.now() - started,
      cacheHits,
      diagnostics: diagnostics.items,
      phases: { ...this.phases }
    }
    // Files named by addWatchFile() only become known once a transform has run,
    // so the watched set is refreshed after every build rather than once.
    this.#collectExtraWatched()
    this.#watchHandle?.sync(config, this.#extraWatched.keys())

    this.#emit({ type: 'build:end', result })
    this.#changedPaths = undefined
    this.#forced = undefined
    this.#refreshContext = undefined
    return result
  }

  /**
   * Rebuild whenever content changes.
   *
   * Pass the host's watcher when one exists — Vite and Nuxt already run one
   * over the project, and a second doubles the handles and the events.
   */
  async watch(options: WatchOptions = {}): Promise<WatchHandle> {
    const config = this.#config ?? (await this.#time('config', () => this.resolve()))
    if (this.#watchHandle) return this.#watchHandle

    const handle = await startWatch(
      config,
      {
        logger: this.#logger,
        rebuild: async (changed, reason) => {
          this.#emit({ type: 'watch:change', path: reason })
          // An external file names no document, so there is no per-document
          // hint to pass; full discovery lets the dependency check find who
          // depended on it.
          const external = this.#touchesWatched(changed)
          const relative = this.#toRelative(changed, this.#config ?? config)
          return await this.build(external ? {} : { changed: relative })
        },
        reload: async () => {
          const previous = this.#config
          try {
            await this.resolve()
          } catch (error) {
            // Keep serving the last good output: a config saved mid-edit is
            // usually a syntax error that the next keystroke fixes.
            this.#config = previous
            this.#logger.warn(
              `config reload failed, keeping the previous one: ${(error as Error).message}`
            )
            return undefined
          }
          this.#resetCaches()
          const result = await this.build()
          // A new collection brings a directory nobody was watching yet.
          this.#watchHandle?.sync(this.#config!, this.#extraWatched.keys())
          return result
        }
      },
      options
    )
    this.#watchHandle = handle
    // A build that already ran knows which external files transforms asked to
    // watch; the handle was created from the config alone and does not.
    handle.sync(config, this.#extraWatched.keys())
    return handle
  }

  /**
   * Refetch remote collections on demand.
   *
   * The entry point a CMS webhook calls: `context` reaches the loader as
   * `refreshContext`, so a handler can re-fetch one entry rather than the whole
   * collection. Astro has this and nothing else in this space does.
   */
  async refreshContent(options: RefreshOptions = {}): Promise<BuildResult> {
    return await this.build({
      ...(options.loaders === undefined ? {} : { forceLoaders: new Set(options.loaders) }),
      ...(options.context === undefined ? {} : { refreshContext: options.context })
    })
  }

  /**
   * Documents the last build produced for a collection.
   *
   * For programmatic consumers — an Astro loader, a search-index script, a
   * test — that already hold the builder. Reading the emitted module back
   * through Node instead would make them depend on `contentmap` being
   * resolvable from the output directory, which is a needless constraint when
   * the data is right here.
   */
  documentsOf(collection: string): AnyDocument[] {
    const built = this.#built.get(collection) ?? { entries: this.#cache.get(collection) ?? [] }
    return built.entries.map(toDocument)
  }

  /** Names of the collections the last build produced. */
  collectionNames(): string[] {
    return [...this.#cache.keys()].sort()
  }

  async close(): Promise<void> {
    this.#abort.abort()
    await this.#watchHandle?.close()
    this.#watchHandle = undefined
  }

  /**
   * Hash the external files a transform declared.
   *
   * Reading them is the point: a path alone says nothing about whether the
   * content behind it moved.
   */
  async #digestWatched(
    paths: readonly string[] | undefined
  ): Promise<{ path: string; digest: string; mtimeMs: number }[] | undefined> {
    if (!paths || paths.length === 0) return undefined
    const unique = [...new Set(paths)].sort()
    const out = await mapLimit(unique, 16, async path => {
      try {
        const [buffer, info] = await Promise.all([
          withFdRetry(() => readFile(path)),
          stat(path)
        ])
        return { path, digest: digestOf(buffer), mtimeMs: info.mtimeMs }
      } catch {
        // Missing is a state like any other: recording it means the file
        // appearing later counts as a change.
        return { path, digest: 'missing', mtimeMs: 0 }
      }
    })
    return out
  }

  /** Gather every path a transform asked to watch, and who asked. */
  #collectExtraWatched(): void {
    this.#extraWatched.clear()
    for (const [name, entries] of this.#cache) {
      for (const entry of entries) {
        for (const { path } of entry.watchDeps ?? []) {
          const owners = this.#extraWatched.get(path)
          if (owners) owners.add(name)
          else this.#extraWatched.set(path, new Set([name]))
        }
      }
    }
  }

  /** Did the change touch a file some transform declared? */
  #touchesWatched(changed: ReadonlySet<string>): boolean {
    for (const path of changed) if (this.#extraWatched.has(path)) return true
    return false
  }

  /** A watcher reports absolute paths; collections match on relative ones. */
  #toRelative(changed: ReadonlySet<string>, config: ResolvedConfig): Set<string> {
    const out = new Set<string>()
    for (const absolute of changed) {
      for (const collection of Object.values(config.collections)) {
        if (!collection.directory) continue
        const rel = relative(collection.directory, absolute)
        if (!rel.startsWith('..') && !isAbsolute(rel)) out.add(toPosix(rel))
      }
    }
    return out
  }

  /** Everything derived from the config must go when the config does. */
  #resetCaches(): void {
    this.#cache.clear()
    this.#previous.clear()
    this.#emitStats = undefined
    this.#transformCache = undefined
    this.#remote = undefined as unknown as RemoteStore
  }

  /**
   * Build a collection, or await the build already in progress.
   *
   * `stack` is the chain of collections that demanded this one. Finding the
   * name already in that chain is a cycle; finding it merely in flight means a
   * sibling document asked first, and we simply wait.
   */
  async #ensureBuilt(
    name: string,
    config: ResolvedConfig,
    diagnostics: DiagnosticBag,
    stack: readonly string[]
  ): Promise<CollectionResult> {
    const done = this.#built.get(name)
    if (done) return done

    const position = stack.indexOf(name)
    if (position !== -1) {
      throw new ReferenceCycleError([...stack.slice(position), name])
    }

    const inFlight = this.#inFlight.get(name)
    if (inFlight) return await inFlight

    const collection = config.collections[name]
    if (!collection) throw new UnknownCollectionError(name, Object.keys(config.collections))

    const promise = this.#buildCollection(collection, config, diagnostics, [...stack, name])
    this.#inFlight.set(name, promise)
    try {
      const result = await promise
      this.#built.set(name, result)
      return result
    } finally {
      this.#inFlight.delete(name)
    }
  }

  async #buildCollection(
    collection: CollectionDefinition,
    config: ResolvedConfig,
    diagnostics: DiagnosticBag,
    stack: readonly string[]
  ): Promise<CollectionResult> {
    if (collection.loader) {
      return await this.#buildFromLoader(collection, config, diagnostics, stack)
    }
    const cachedEntries = this.#cache.get(collection.name) ?? []

    // A document whose IMAGE changed is stale even though its own file did not.
    // Velite invalidates only the edited content file, so a rebuilt site keeps
    // serving fingerprinted URLs for bytes that no longer exist.
    const previous = await this.#dropAssetStale(
      this.#previous.get(collection.name),
      cachedEntries,
      config,
      diagnostics,
      stack,
      collection
    )
    const collected = await this.#time('read', () =>
      collectFiles(collection, config, {
        ...(previous === undefined ? {} : { previous }),
        ...(this.#changedPaths === undefined ? {} : { changed: this.#changedPaths })
      })
    )

    // Read failures are diagnostics, never silence. An fd-exhausted or
    // permission-denied build must be visible and must fail.
    for (const failure of collected.failures) {
      diagnostics.add({
        code: 'CM_READ',
        severity: 'error',
        message: failure.error.message,
        file: failure.relativePath,
        collection: collection.name,
        hint: 'The file matched the collection pattern but could not be read.'
      })
    }

    if (collected.files.length === 0 && collected.unchanged.length === 0) {
      diagnostics.add({
        code: 'CM_NO_MATCH',
        severity: 'warning',
        message: `No files matched in ${String(collection.directory)}`,
        collection: collection.name,
        hint: `Pattern: ${String(collection.include)}`
      })
    }

    const cached = cachedEntries
    const cacheHits = collected.unchanged.length
    this.#scanned += cached.filter(e => collected.unchanged.includes(e.meta.filePath)).length

    const parsedGroups = await mapLimit(collected.files, config.concurrency, async file =>
      this.#processFile(file, collection, config, diagnostics, stack)
    )

    const fresh = parsedGroups.flat()

    // Only files we did NOT re-read may reuse a cached entry. Keying on every
    // path we saw would resurrect stale data whenever an edited file stopped
    // validating — the document would vanish from `fresh`, and its previous
    // version would silently survive into the output.
    const reusable = new Set(collected.unchanged)
    const entries: StoreEntry[] = cached.filter(e => reusable.has(e.meta.filePath))

    // Reused documents never re-register their assets, so readopt them or the
    // copier will delete files the emitted HTML still points at. The same holds
    // for their transform-cache entries: a document that was not reprocessed
    // never calls ctx.cache(), so without this its entries look unused and get
    // recomputed on the next build.
    for (const entry of entries) {
      if (entry.assets?.length) {
        this.#assets.adopt(refKey(collection.name, entry.id), entry.assets)
      }
      await this.#transformCache?.retain(collection.name, entry.id)
    }
    entries.push(...fresh)

    // ── duplicate identity ──────────────────────────────────────────────────
    // `a/index.md` and `a.md` both resolve to the id `a`. Emitting both would
    // have one module silently overwrite the other and leave a duplicate key in
    // the loader map — data loss reported as success.
    const seen = new Map<string, string>()
    const unique: StoreEntry[] = []
    for (const entry of entries) {
      const first = seen.get(entry.id)
      if (first !== undefined) {
        diagnostics.add({
          code: 'CM_DUPLICATE_ID',
          severity: 'error',
          message: `Duplicate document id "${entry.id}"`,
          file: entry.meta.filePath,
          collection: collection.name,
          documentId: entry.id,
          hint: `Already produced by "${first}". Rename one, or narrow the collection's \`include\`.`
        })
        continue
      }
      seen.set(entry.id, entry.meta.filePath)
      unique.push(entry)
    }

    // Stable by id so output is byte-reproducible, then the user's sort.
    unique.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    if (collection.sort) applySort(unique, collection.sort)

    if (collection.single && unique.length !== 1) {
      diagnostics.add({
        code: 'CM_SINGLETON',
        severity: 'error',
        message: `Collection "${collection.name}" is \`single\` but matched ${unique.length} documents`,
        collection: collection.name,
        hint:
          unique.length === 0
            ? `No file matched ${String(collection.include)} in ${String(collection.directory)}.`
            : `Matched: ${unique.map(e => e.meta.filePath).join(', ')}`
      })
    }

    const finalEntries = unique
    this.#cache.set(collection.name, finalEntries)
    this.#previous.set(
      collection.name,
      new Map(
        finalEntries.map(
          e => [e.meta.filePath, { mtimeMs: e.mtimeMs, digest: e.digest }] as const
        )
      )
    )
    return { entries: finalEntries, cacheHits }
  }

  /**
   * Run a collection's transform.
   *
   * Returns undefined when the document should be dropped — either the
   * transform called `skip()`, or it threw. A transform that throws is a
   * diagnostic naming the file, never an unhandled rejection: velite lets a
   * bad date escape as a bare `RangeError: Invalid time value` with no
   * filename at all.
   */
  #runTransform(
    collection: CollectionDefinition,
    validated: Record<string, unknown>,
    documentMeta: DocumentMeta,
    file: { relativePath: string; absolutePath: string; content: string },
    body: string,
    diagnostics: DiagnosticBag,
    stack: readonly string[]
  ): Promise<Record<string, unknown> | undefined> {
    return this.#time('transform', () => this.#runTransformInner(collection, validated, documentMeta, file, body, diagnostics, stack))
  }

  async #runTransformInner(
    collection: CollectionDefinition,
    validated: Record<string, unknown>,
    documentMeta: DocumentMeta,
    file: { relativePath: string; absolutePath: string; content: string },
    body: string,
    diagnostics: DiagnosticBag,
    stack: readonly string[]
  ): Promise<Record<string, unknown> | undefined> {
    const assets = this.#assetContext(collection, documentMeta, file.absolutePath)
    const ctx = createTransformContext({
      meta: documentMeta,
      // The parser's body, NOT validated[BODY_FIELD]: a schema that does not
      // declare `content` has it stripped, which would leave ctx.body empty.
      body,
      path: file.absolutePath,
      renderer: this.#config?.renderer,
      logger: this.#logger,
      ...assets,
      services: this.#services(collection, documentMeta, diagnostics, stack)
    })

    try {
      const produced = await collection.transform!(validated, ctx)
      if (produced === null || typeof produced !== 'object' || Array.isArray(produced)) {
        diagnostics.add({
          code: 'CM_TRANSFORM',
          severity: 'error',
          message: `transform must return an object, got ${describeValue(produced)}`,
          file: file.relativePath,
          collection: collection.name,
          documentId: documentMeta.id
        })
        return undefined
      }
      return produced as Record<string, unknown>
    } catch (error) {
      // A cycle is a configuration problem, not a problem with one document.
      // Reporting it per-file would print the same structural error against
      // every document in both collections.
      if (error instanceof ReferenceCycleError) throw error
      if (isSkipSignal(error)) {
        diagnostics.add({
          code: 'CM_SKIPPED',
          severity: 'info',
          message: error.reason ?? 'skipped by transform',
          file: file.relativePath,
          collection: collection.name,
          documentId: documentMeta.id
        })
        return undefined
      }
      const err = error as Error & { hint?: string }
      diagnostics.add({
        code: 'CM_TRANSFORM',
        severity: 'error',
        message: err?.message ?? String(error),
        file: file.relativePath,
        collection: collection.name,
        documentId: documentMeta.id,
        ...(err?.hint === undefined ? {} : { hint: err.hint })
      })
      return undefined
    }
  }

  /**
   * Remove documents whose referenced assets changed from the reuse set, so
   * they get re-read and re-processed like any other stale file.
   */
  /** Has anything this document depends on changed since it was built? */
  async #dependenciesChanged(
    entry: StoreEntry,
    collection: CollectionDefinition,
    config: ResolvedConfig,
    diagnostics: DiagnosticBag,
    stack: readonly string[]
  ): Promise<boolean> {
    if (entry.assetDeps?.length && (await this.#assets.changed(entry.assetDeps))) return true
    if (entry.watchDeps?.length && (await this.#assets.changed(entry.watchDeps))) return true
    if (entry.refDeps?.length) {
      return await this.#referencesChanged(entry.refDeps, config, diagnostics, stack, collection)
    }
    return false
  }

  async #dropAssetStale(
    previous: Map<string, PreviousState> | undefined,
    cached: readonly StoreEntry[],
    config: ResolvedConfig,
    diagnostics: DiagnosticBag,
    stack: readonly string[],
    collection: CollectionDefinition
  ): Promise<Map<string, PreviousState> | undefined> {
    if (!previous) return previous
    let next: Map<string, PreviousState> | undefined

    for (const entry of cached) {
      if (await this.#dependenciesChanged(entry, collection, config, diagnostics, stack)) {
        next ??= new Map(previous)
        next.delete(entry.meta.filePath)
      }
    }
    return next ?? previous
  }

  /**
   * Has a document this one embedded changed?
   *
   * Editing an author has to refresh every post that embedded them. Contentlayer
   * carries the opposite behaviour as a known gap — `// TODO take care of case
   * where embedded document was updated in the meantime`.
   */
  async #referencesChanged(
    refs: readonly { collection: string; id: string; digest: string }[],
    config: ResolvedConfig,
    diagnostics: DiagnosticBag,
    stack: readonly string[],
    self: CollectionDefinition
  ): Promise<boolean> {
    for (const ref of refs) {
      // A collection that no longer exists means the reference is gone too.
      const definition = config.collections[ref.collection]
      if (!definition) return true

      // A dependency on this collection itself comes from siblings(), and is
      // answered from the validated form rather than by building the
      // collection — which is exactly what we are deciding how to do.
      if (ref.collection === self.name) {
        if (ref.id !== '*') continue
        const all = await this.#validatedDocuments(self, config, diagnostics)
        if (cacheKey(...all.map(d => stableStringify(d))) !== ref.digest) return true
        continue
      }

      if (stack.includes(ref.collection)) continue
      const target = await this.#ensureBuilt(ref.collection, config, diagnostics, stack)
      if (ref.id === '*') {
        if (cacheKey(...target.entries.map(e => e.emitKey)) !== ref.digest) return true
        continue
      }
      const found = target.entries.find(e => e.id === ref.id)
      if (!found || found.emitKey !== ref.digest) return true
    }
    return false
  }

  /**
   * Build a collection from a loader rather than from files.
   *
   * The shape mirrors the file path deliberately: records are validated,
   * transformed and cached the same way, so a remote collection is a first
   * class citizen rather than a bolt-on. What differs is identity — a record
   * has no path, so the loader must supply an id — and change detection, which
   * uses the record digest the loader reports.
   */
  async #buildFromLoader(
    collection: CollectionDefinition,
    config: ResolvedConfig,
    diagnostics: DiagnosticBag,
    stack: readonly string[]
  ): Promise<CollectionResult> {
    const loader = collection.loader!
    await this.#remote.load(collection.name)

    const context: LoaderContext = {
      collection: collection.name,
      meta: this.#remote.metaStore(collection.name),
      logger: this.#logger,
      config,
      signal: this.#abort.signal,
      frozen: config.frozen,
      forced: this.#forced?.has(collection.name) ?? false,
      ...(this.#refreshContext === undefined ? {} : { refreshContext: this.#refreshContext }),
      digest: input => digestOf(input),
      snapshot: () => this.#remote.snapshot(collection.name),
      save: records => this.#remote.save(collection.name, records)
    }

    let loaded
    try {
      loaded = await this.#time('load', () => Promise.resolve(loader.load(context)))
    } catch (error) {
      const err = error as Error & { hint?: string }
      diagnostics.add({
        code: 'CM_LOADER',
        severity: 'error',
        // Redacted: a failing request must not print a token into CI logs.
        message: redactSecrets(err.message ?? String(error)),
        collection: collection.name,
        ...(err.hint === undefined ? {} : { hint: redactSecrets(err.hint) })
      })
      return { entries: [], cacheHits: 0 }
    }

    this.#loaded.set(collection.name, loaded.records)

    const cached = this.#cache.get(collection.name) ?? []
    const previousDigests = new Map(cached.map(e => [e.id, e.digest] as const))
    const reusable = new Map(cached.map(e => [e.id, e] as const))

    const entries: StoreEntry[] = []
    let cacheHits = 0
    const seen = new Map<string, number>()

    // Validating and transforming records is CPU-bound, exactly like the file
    // path. How many requests a loader makes is the loader's own business.
    const results = await mapLimit(loaded.records, config.concurrency, async record => {
      this.#scanned += 1

      const duplicate = seen.get(record.id)
      if (duplicate !== undefined) {
        diagnostics.add({
          code: 'CM_DUPLICATE_ID',
          severity: 'error',
          message: `Duplicate record id "${record.id}" from loader "${loader.name}"`,
          collection: collection.name,
          documentId: record.id,
          hint: 'Ids must be unique within a collection. Check the loader\'s `id` function.'
        })
        return undefined
      }
      seen.set(record.id, 1)

      const unchanged = previousDigests.get(record.id) === record.digest
      const prior = reusable.get(record.id)
      // The record being unchanged is necessary but not sufficient: it may
      // embed a document or reference an image that moved underneath it. The
      // file path learned this the hard way; the loader path gets it for free
      // by sharing the same check.
      if (unchanged && prior && !(await this.#dependenciesChanged(prior, collection, config, diagnostics, stack))) {
        cacheHits += 1
        await this.#transformCache?.retain(collection.name, record.id)
        // Reused documents never re-register their assets, so readopt them or
        // the copier removes files the emitted output still points at.
        if (prior.assets?.length) {
          this.#assets.adopt(refKey(collection.name, prior.id), prior.assets)
        }
        return prior
      }

      return await this.#processRecord(record, collection, config, diagnostics, stack)
    })

    for (const entry of results) if (entry) entries.push(entry)
    entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    if (collection.sort) applySort(entries, collection.sort)

    if (collection.single && entries.length !== 1) {
      diagnostics.add({
        code: 'CM_SINGLETON',
        severity: 'error',
        message: `Collection "${collection.name}" is \`single\` but the loader produced ${entries.length} records`,
        collection: collection.name
      })
    }

    this.#cache.set(collection.name, entries)
    return { entries, cacheHits }
  }

  /** Validate and transform one loader record. */
  async #processRecord(
    record: LoadedRecord,
    collection: CollectionDefinition,
    config: ResolvedConfig,
    diagnostics: DiagnosticBag,
    stack: readonly string[]
  ): Promise<StoreEntry | undefined> {
    const meta = metaForRecord(record, collection)
    const source = meta.filePath

    const raw: Record<string, unknown> = { ...record.data }
    let injectedBody: string | undefined
    if (record.body !== undefined && !(BODY_FIELD in raw)) {
      raw[BODY_FIELD] = record.body
      injectedBody = BODY_FIELD
    }

    const policy = config.onValidationError
    const result = await this.#time('validate', () => validate(collection.schema, raw))
    if (!result.ok) {
      if (policy !== 'ignore') {
        for (const issue of result.issues) {
          diagnostics.add({
            code: 'CM_VALIDATION',
            severity: policy === 'fail' ? 'error' : 'warning',
            message: issue.message,
            file: source,
            ...(issue.path === undefined ? {} : { field: issue.path }),
            collection: collection.name,
            documentId: record.id,
            ...hintFor(issue.path, Object.keys(raw))
          })
        }
      }
      if (policy !== 'warn') return undefined
    } else {
      reportUnknownFields(raw, result.value, injectedBody, {
        file: source,
        source: '',
        collection: collection.name,
        documentId: record.id,
        policy: config.onUnknownField,
        diagnostics
      })
    }

    let data: Record<string, unknown> = result.ok ? result.value : raw
    if (collection.transform) {
      const transformed = await this.#runTransform(
        collection,
        data,
        meta,
        { relativePath: source, absolutePath: source, content: '' },
        record.body ?? '',
        diagnostics,
        stack
      )
      if (transformed === undefined) {
        const failed = refKey(collection.name, record.id)
        this.#refsFor.delete(failed)
        this.#watchFor.delete(failed)
        return undefined
      }
      data = transformed
    }

    const ownerId = refKey(collection.name, record.id)
    const owned = this.#assets.ownedBy(ownerId)
    const assetDeps = owned.length === 0 ? undefined : this.#assets.dependencies(ownerId)
    const refDeps = dedupeRefs(this.#refsFor.get(ownerId))
    this.#refsFor.delete(ownerId)
    this.#watchFor.delete(ownerId)

    return {
      id: record.id,
      collection: collection.name,
      digest: record.digest,
      emitKey: cacheKey(
        record.digest,
        ...(assetDeps ?? []).map(d => d.digest),
        ...(refDeps ?? []).map(r => `${r.collection}/${r.id}@${r.digest}`)
      ),
      data,
      meta,
      mtimeMs: 0,
      ...(assetDeps === undefined ? {} : { assets: owned, assetDeps }),
      ...(refDeps === undefined ? {} : { refDeps })
    }
  }

  /**
   * Every document in a collection as the schema validated it, before any
   * transform ran.
   *
   * This is what makes sibling access possible. A transform cannot read its own
   * collection's transformed output — the collection would depend on itself —
   * but the validated form is well defined and non-circular. Computed by
   * re-reading the collection independently of the incremental path, because
   * cached entries only retain their POST-transform data.
   */
  #validatedDocuments(
    collection: CollectionDefinition,
    config: ResolvedConfig,
    diagnostics: DiagnosticBag
  ): Promise<AnyDocument[]> {
    const existing = this.#validated.get(collection.name)
    if (existing) return existing

    const promise = (async () => {
      if (collection.loader) {
        // A loader-backed collection has no files to re-read, and the built
        // entries do not exist yet while its own transforms are running —
        // reading them would silently return an empty list. Validate the
        // records the loader already produced instead.
        const records = this.#loaded.get(collection.name) ?? []
        const docs = await mapLimit(records, config.concurrency, async record => {
          const raw: Record<string, unknown> = { ...record.data }
          if (record.body !== undefined && !(BODY_FIELD in raw)) raw[BODY_FIELD] = record.body
          const result = await this.#time('validate', () => validate(collection.schema, raw))
          if (!result.ok) return undefined
          return { ...result.value, _meta: metaForRecord(record, collection) } as AnyDocument
        })
        return docs
          .filter((d): d is AnyDocument => d !== undefined)
          .sort((a, b) => (a._meta.id < b._meta.id ? -1 : a._meta.id > b._meta.id ? 1 : 0))
      }
      const collected = await collectFiles(collection, config, {})
      const groups = await mapLimit(collected.files, config.concurrency, async file =>
        this.#parseFile(file, collection, config, diagnostics, false)
      )
      return groups
        .flat()
        .map(p => ({ ...p.validated, _meta: p.meta }) as AnyDocument)
        .sort((a, b) => (a._meta.id < b._meta.id ? -1 : a._meta.id > b._meta.id ? 1 : 0))
    })()
    this.#validated.set(collection.name, promise)
    return promise
  }

  /**
   * Relations, caching and file emission for one document.
   */
  #services(
    collection: CollectionDefinition,
    documentMeta: DocumentMeta,
    diagnostics: DiagnosticBag,
    stack: readonly string[]
  ): ContextServices {
    const config = this.#config!
    const refs: { collection: string; id: string; digest: string }[] = []
    const watchFiles: string[] = []
    this.#refsFor.set(refKey(collection.name, documentMeta.id), refs)
    this.#watchFor.set(refKey(collection.name, documentMeta.id), watchFiles)

    const targetOf = async (ref: CollectionRef): Promise<{ name: string; result: CollectionResult }> => {
      const name =
        typeof ref === 'string' ? ref : ((ref as { name?: string }).name ?? '')
      if (!name || !config.collections[name]) {
        throw new UnknownCollectionError(String(name), Object.keys(config.collections))
      }
      return { name, result: await this.#ensureBuilt(name, config, diagnostics, stack) }
    }

    const lookup = async (
      ref: CollectionRef,
      id: string,
      /** Embedding copies content, so the referrer depends on it. A bare
       *  reference keeps only the id, so it depends on existence alone —
       *  tracking content there would rebuild every referrer on any edit to the
       *  target, which is the cost `reference()` exists to avoid. */
      mode: 'embed' | 'exists' = 'embed'
    ): Promise<StoreEntry> => {
      const { name, result } = await targetOf(ref)
      const found = result.entries.find(e => e.id === id)
      if (!found) {
        // Existence is checked for scalars AND lists. Contentlayer validates
        // only the scalar case and ships `// TODO also check for references in
        // lists`, so a broken list reference passes silently.
        throw new MissingReferenceError(name, id, result.entries.map(e => e.id))
      }
      refs.push({ collection: name, id, digest: mode === 'embed' ? found.emitKey : 'exists' })
      return found
    }

    return {
      siblings: async () => {
        const all = await this.#validatedDocuments(collection, config, diagnostics)
        // The whole collection is a dependency: adding or removing any document
        // changes what every other one sees.
        refs.push({
          collection: collection.name,
          id: '*',
          digest: cacheKey(...all.map(d => stableStringify(d)))
        })
        return all.filter(d => d._meta.id !== documentMeta.id)
      },
      documents: async ref => {
        const requested =
          typeof ref === 'string' ? ref : ((ref as { name?: string }).name ?? '')
        if (requested === collection.name) {
          throw new SelfReferenceError(collection.name)
        }
        const { name, result } = await targetOf(ref)
        // Depend on the whole collection, so adding or removing a document in
        // it invalidates this one.
        refs.push({
          collection: name,
          id: '*',
          digest: cacheKey(...result.entries.map(e => e.emitKey))
        })
        return result.entries.map(toDocument)
      },
      resolve: async (ref, id) => toDocument(await lookup(ref, id)),
      resolveMany: async (ref, ids) => {
        const settled = await Promise.allSettled(ids.map(id => lookup(ref, id)))
        const rejected = settled.filter(r => r.status === 'rejected') as PromiseRejectedResult[]

        // A cycle or an unknown collection is not a missing id; repackaging it
        // would report a structural problem as a typo.
        const other = rejected.find(r => !(r.reason instanceof MissingReferenceError))
        if (other) throw other.reason

        if (rejected.length > 0) {
          // Report every missing id, not just the first: fixing them one build
          // at a time is miserable on a large corpus.
          const missing = settled
            .map((r, i) => (r.status === 'rejected' ? ids[i] : undefined))
            .filter((v): v is string => v !== undefined)
          const err = rejected[0]!.reason as MissingReferenceError
          throw new MissingReferenceError(err.collection, missing.join('", "'), err.known)
        }
        return settled.map(r => toDocument((r as PromiseFulfilledResult<StoreEntry>).value))
      },
      reference: async (ref, id) => {
        await lookup(ref, id, 'exists')
        return id
      },
      cache: (input, fn, options) =>
        this.#transformCache!.through(
          collection.name,
          documentMeta.id,
          input,
          fn,
          options?.key
        ),
      emitFile: async (name, content) => {
        const target = join(config.output.dir, 'files', name)
        if (!config.dryRun) {
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, content)
        }
        return target
      },
      addWatchFile: path => {
        watchFiles.push(resolve(dirname(from(documentMeta, config)), path))
      }
    }
  }

  /**
   * Asset handling scoped to one document.
   *
   * Relative references resolve against the REFERRING FILE, not the collection
   * root, because that is how an author reads their own markdown.
   */
  #assetContext(
    collection: CollectionDefinition,
    documentMeta: DocumentMeta,
    from: string
  ): {
    resolveAsset: (url: string) => Promise<{ src: string; sourcePath: string; size: number } | undefined>
    resolveImage: (url: string) => Promise<Image | undefined>
    rewrite: (html: string) => Promise<string>
  } {
    const config = this.#config!
    const ownerId = `${collection.name}\u0000${documentMeta.id}`

    const register = async (url: string) => {
      const { path: rawPath, suffix } = splitUrl(url)
      if (!isRelativeUrl(rawPath)) return undefined
      const ext = extname(rawPath).toLowerCase()
      // The allowlist is what keeps `[see](./other.md)` from being read as an
      // asset, failing, and taking the whole document with it.
      if (!config.assetExtensions.includes(ext)) return undefined

      // A malformed percent-escape is not an asset reference; leaving the URL
      // alone beats failing the document over it.
      let decoded: string
      try {
        decoded = decodeURI(rawPath)
      } catch {
        return undefined
      }

      const sourcePath = resolve(dirname(from), decoded)
      // Content must not reach outside the project. `../../../etc/x.png` would
      // otherwise copy a file the author never intended to publish into the
      // public output directory.
      const rel = relative(config.root, sourcePath)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new OutsideRootError(url, sourcePath)
      }

      return await this.#assets.register({
        sourcePath,
        template: config.output.assetsName,
        base: config.output.assetsBase,
        suffix,
        ownerId
      })
    }

    const measure = async (url: string): Promise<Image | undefined> => {
      const registered = await register(url)
      if (!registered) return undefined
      const processor = config.images
      const measured = processor
        ? await processor.measure(registered.buffer, registered.sourcePath)
        : undefined
      const base = {
        src: registered.src,
        size: registered.size,
        width: measured?.width ?? 0,
        height: measured?.height ?? 0,
        format: measured?.format ?? extname(registered.sourcePath).slice(1),
        aspectRatio: measured && measured.height > 0 ? measured.width / measured.height : 0
      }
      if (!processor?.placeholder || !measured) return base
      const placeholder = await processor.placeholder(registered.buffer, registered.sourcePath)
      return placeholder
        ? { ...base, placeholder: placeholder.dataUri, color: placeholder.color }
        : base
    }

    return {
      resolveAsset: async url => {
        const registered = await register(url)
        return registered
          ? { src: registered.src, sourcePath: registered.sourcePath, size: registered.size }
          : undefined
      },
      resolveImage: measure,
      rewrite: async html => {
        const result = await rewriteHtml(html, {
          resolve: async (url): Promise<ResolvedAsset | undefined> => {
            try {
            const ext = extname(splitUrl(url).path).toLowerCase()
            if (isImageExtension(ext) && config.images) {
              const measured = await measure(url)
              if (!measured) return undefined
              return {
                src: measured.src,
                sourcePath: resolve(dirname(from), decodeURI(splitUrl(url).path)),
                ...(measured.width > 0 ? { width: measured.width, height: measured.height } : {})
              }
            }
            const registered = await register(url)
            return registered
              ? { src: registered.src, sourcePath: registered.sourcePath }
              : undefined
            } catch (error) {
              if (error instanceof OutsideRootError) {
                this.#logger.warn(
                  `${documentMeta.filePath}: ignoring "${error.url}" — outside the project root`
                )
                return undefined
              }
              throw error
            }
          }
        })
        return result.html
      }
    }
  }

  /**
   * Parse and validate one file. No transform runs here.
   *
   * Split out so the validated form of a whole collection can be produced
   * without executing transforms, which is what `siblings()` needs.
   */
  async #parseFile(
    file: SourceFile,
    collection: CollectionDefinition,
    config: ResolvedConfig,
    diagnostics: DiagnosticBag,
    count = true
  ): Promise<ParsedDocument[]> {
    const parser = resolveParser(
      file.extension || extname(file.relativePath),
      collection.parser,
      config.parsers
    )
    if (!parser) {
      if (count) this.#scanned += 1
      diagnostics.add({
        code: 'CM_PARSE',
        severity: 'error',
        message: `No parser for "${file.extension}"`,
        file: file.relativePath,
        collection: collection.name,
        hint: 'Register one with defineParser, or narrow the collection `include` pattern.'
      })
      return []
    }

    let parsed
    try {
      parsed = await this.#time('parse', () =>
        parser.parse({ content: file.content, path: file.absolutePath })
      )
    } catch (error) {
      // js-yaml (vendored by confbox) appends its own multi-line ASCII frame to
      // `.message`. Left alone it lands inside our tree with foreign
      // indentation and makes --json messages multi-line.
      if (count) this.#scanned += 1
      const { message, position } = normalizeParserError(error)
      diagnostics.add({
        code: 'CM_PARSE',
        severity: 'error',
        message,
        file: file.relativePath,
        collection: collection.name,
        ...(position
          ? { line: position.line, ...(position.column === undefined ? {} : { column: position.column }) }
          : {}),
        ...(position ? { frame: codeFrame(file.content, position) } : {}),
        hint: `Parsed with the "${parser.name}" parser.`
      })
      return []
    }

    const records = Array.isArray(parsed) ? parsed : [parsed]
    if (count) this.#scanned += records.length
    const meta = metaFor(file, collection.directory ?? '')
    const out: ParsedDocument[] = []

    for (const [index, record] of records.entries()) {
      const many = records.length > 1
      const id = many ? `${meta.id}[${index}]` : meta.id
      const raw: Record<string, unknown> = { ...record.data }
      // Remember whether WE injected the body, so it is never reported as an
      // unknown field for a schema that simply does not want it.
      let injectedBody: string | undefined
      if (parser.hasBody && record.body !== undefined && !(BODY_FIELD in raw)) {
        raw[BODY_FIELD] = record.body
        injectedBody = BODY_FIELD
      }

      const policy = config.onValidationError
      const result = await this.#time('validate', () => validate(collection.schema, raw))

      if (!result.ok) {
        if (policy !== 'ignore') {
          const known = Object.keys(raw)
          for (const issue of result.issues) {
            // A validator reports the field path but knows nothing about the
            // file, so locate the key ourselves to get a caret on the line.
            const at = issue.path ? findKeyPosition(file.content, issue.path) : undefined
            diagnostics.add({
              code: 'CM_VALIDATION',
              // fail => error (build stops). warn/skip => warning (build
              // continues); they differ only in whether the document survives.
              severity: policy === 'fail' ? 'error' : 'warning',
              message: issue.message,
              file: file.relativePath,
              ...(issue.path === undefined ? {} : { field: issue.path }),
              ...(at
                ? { line: at.line, ...(at.column === undefined ? {} : { column: at.column }) }
                : {}),
              ...(at ? { frame: codeFrame(file.content, at) } : {}),
              collection: collection.name,
              documentId: id,
              ...hintFor(issue.path, known)
            })
          }
        }
        // Only 'warn' keeps the invalid document. Emitting a record that
        // violates its own declared type makes the generated .d.ts a lie.
        if (policy !== 'warn') continue
      } else {
        reportUnknownFields(raw, result.value, injectedBody, {
          file: file.relativePath,
          source: file.content,
          collection: collection.name,
          documentId: id,
          policy: config.onUnknownField,
          diagnostics
        })
      }

      out.push({
        id,
        meta: many ? { ...meta, id } : meta,
        validated: result.ok ? result.value : raw,
        body: record.body ?? ''
      })
    }
    return out
  }

  /** Parse, validate, then transform. Produces the entries that get emitted. */
  async #processFile(
    file: SourceFile,
    collection: CollectionDefinition,
    config: ResolvedConfig,
    diagnostics: DiagnosticBag,
    stack: readonly string[]
  ): Promise<StoreEntry[]> {
    const parsed = await this.#parseFile(file, collection, config, diagnostics)
    const out: StoreEntry[] = []

    for (const pending of parsed) {
      let data: Record<string, unknown> = pending.validated
      if (collection.transform) {
        const transformed = await this.#runTransform(
          collection,
          pending.validated,
          pending.meta,
          file,
          pending.body,
          diagnostics,
          stack
        )
        if (transformed === undefined) {
          // The transform failed or skipped, so nothing will harvest these.
          const failed = refKey(collection.name, pending.id)
          this.#refsFor.delete(failed)
          this.#watchFor.delete(failed)
          continue
        }
        data = transformed
      }

      const ownerId = refKey(collection.name, pending.id)
      const owned = this.#assets.ownedBy(ownerId)
      const assetDeps = owned.length === 0 ? undefined : this.#assets.dependencies(ownerId)
      const refDeps = dedupeRefs(this.#refsFor.get(ownerId))
      const watchDeps = await this.#digestWatched(this.#watchFor.get(ownerId))
      this.#refsFor.delete(ownerId)
      this.#watchFor.delete(ownerId)

      out.push({
        id: pending.id,
        collection: collection.name,
        digest: file.digest,
        // Output depends on the source file, every asset it references, and
        // every document it embedded.
        emitKey: cacheKey(
          file.digest,
          ...(assetDeps ?? []).map(d => d.digest),
          ...(refDeps ?? []).map(r => `${r.collection}/${r.id}@${r.digest}`),
          ...(watchDeps ?? []).map(w => `${w.path}@${w.digest}`)
        ),
        data,
        meta: pending.meta,
        mtimeMs: file.mtimeMs,
        ...(assetDeps === undefined ? {} : { assets: owned, assetDeps }),
        ...(refDeps === undefined ? {} : { refDeps }),
        ...(watchDeps === undefined ? {} : { watchDeps })
      })
    }
    return out
  }
}

interface UnknownFieldContext {
  file: string
  source: string
  collection: string
  documentId: string
  policy: Severity
  diagnostics: DiagnosticBag
}

/**
 * Report frontmatter keys the schema discarded.
 *
 * Most validators strip unknown keys silently, so `catgeory: news` simply
 * vanishes and the author never learns their typo did nothing. Comparing the
 * parsed input against the validated output recovers that signal without
 * requiring a strict schema.
 */
function reportUnknownFields(
  raw: Record<string, unknown>,
  validated: Record<string, unknown>,
  injectedBody: string | undefined,
  ctx: UnknownFieldContext
): void {
  if (ctx.policy === 'ignore') return
  // A passthrough or non-object result carries no reliable signal.
  if (validated === null || typeof validated !== 'object') return

  const declared = Object.keys(validated)
  for (const key of Object.keys(raw)) {
    if (key === injectedBody) continue
    if (key in validated) continue
    const at = findKeyPosition(ctx.source, key)
    ctx.diagnostics.add({
      code: 'CM_UNKNOWN_FIELD',
      severity: ctx.policy === 'fail' ? 'error' : 'warning',
      message: `"${key}" is not in the schema and was discarded`,
      file: ctx.file,
      field: key,
      ...(at ? { line: at.line, ...(at.column === undefined ? {} : { column: at.column }) } : {}),
      ...(at ? { frame: codeFrame(ctx.source, at) } : {}),
      collection: ctx.collection,
      documentId: ctx.documentId,
      ...hintForUnknown(key, declared)
    })
  }
}

function hintForUnknown(key: string, declared: readonly string[]): { hint?: string } {
  const guess = suggest(key, declared)
  return guess ? { hint: `Did you mean "${guess}"?` } : {}
}

/** A relative reference that escapes the project root. */
class OutsideRootError extends Error {
  override readonly name = 'OutsideRootError'
  readonly url: string
  readonly hint: string
  constructor(url: string, resolved: string) {
    super(`"${url}" resolves outside the project root (${resolved})`)
    this.url = url
    this.hint = 'Assets must live inside the project. Move the file, or set `root` in your config.'
  }
}

/** A transform asking for its own collection through `documents()`. */
export class SelfReferenceError extends Error {
  override readonly name = 'SelfReferenceError'
  readonly hint =
    'Use `ctx.siblings()` for the other documents in this collection. They are the schema-validated form, because a transform cannot see its own collection\'s transformed output.'
  constructor(collection: string) {
    super(`Collection "${collection}" cannot read itself through documents()`)
  }
}

export class MissingReferenceError extends Error {
  override readonly name = 'MissingReferenceError'
  readonly collection: string
  readonly known: readonly string[]
  readonly hint: string
  constructor(collection: string, id: string, known: readonly string[]) {
    super(`"${id}" not found in collection "${collection}"`)
    this.collection = collection
    this.known = known
    const guess = suggest(id.split('", "')[0] ?? id, known)
    this.hint = guess ? `Did you mean "${guess}"?` : `${known.length} document(s) in that collection.`
  }
}

const refKey = (collection: string, id: string): string => `${collection}\u0000${id}`

/**
 * Metadata for a record that has no file behind it.
 *
 * `filePath` becomes `<loader>:<id>`, which is what diagnostics print, so a
 * failure in a remote collection still says where it came from.
 */
function metaForRecord(record: LoadedRecord, collection: CollectionDefinition): DocumentMeta {
  const loader = collection.loader?.name ?? 'loader'
  return {
    id: record.id,
    filePath: `${loader}:${record.id}`,
    fileName: record.id,
    directory: loader,
    extension: '',
    path: record.id,
    slug: record.id.split('/').pop() ?? record.id,
    digest: record.digest
  }
}

function applySort(
  entries: StoreEntry[],
  compare: (a: AnyDocument, b: AnyDocument) => number
): void {
  const docs = entries.map(e => ({ ...e.data, _meta: e.meta }) as AnyDocument)
  const order = entries.map((_, i) => i)
  order.sort((x, y) => compare(docs[x]!, docs[y]!))
  entries.splice(0, entries.length, ...order.map(i => entries[i]!))
}

function dedupeRefs(
  refs: readonly { collection: string; id: string; digest: string }[] | undefined
): { collection: string; id: string; digest: string }[] | undefined {
  if (!refs || refs.length === 0) return undefined
  const seen = new Map<string, { collection: string; id: string; digest: string }>()
  for (const ref of refs) seen.set(`${ref.collection}\u0000${ref.id}`, ref)
  return [...seen.values()].sort(
    (a, b) => a.collection.localeCompare(b.collection) || a.id.localeCompare(b.id)
  )
}

/**
 * A store entry as a transform sees it.
 *
 * `digest` is stripped for the same reason the emitter strips it: it is a
 * build-internal value, and an embedded document is written to disk just like
 * any other, so leaking it here puts it right back in the output.
 */
function toDocument(entry: StoreEntry): AnyDocument {
  const { digest: _digest, ...meta } = entry.meta
  return { ...entry.data, _meta: meta as DocumentMeta }
}

function from(meta: DocumentMeta, config: ResolvedConfig): string {
  return resolve(config.root, meta.filePath)
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value
}

function hintFor(field: string | undefined, known: readonly string[]): { hint?: string } {
  if (!field) return {}
  const root = field.split(/[.[]/)[0]
  if (!root || known.includes(root)) return {}
  const guess = suggest(root, known)
  return guess ? { hint: `Did you mean "${guess}"?` } : {}
}

export function createBuilder(options: BuilderOptions = {}): Builder {
  return new Builder(options)
}

export type { Diagnostic }
