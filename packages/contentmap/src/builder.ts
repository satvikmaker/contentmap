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
import { mapLimit } from './utils/limit.ts'
import { cacheKey } from './utils/digest.ts'
import { suggest } from './utils/paths.ts'
/** Field the frontmatter parsers write the document body into. */
const BODY_FIELD = 'content'

import type {
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
  #scanned = 0
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

  /** Wall-clock per phase, for `--profile`. */
  readonly phases: Record<string, number> = {}

  #time<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    const t = performance.now()
    return fn().finally(() => {
      this.phases[phase] = (this.phases[phase] ?? 0) + (performance.now() - t)
    })
  }

  async build(): Promise<BuildResult> {
    const started = performance.now()
    for (const k of Object.keys(this.phases)) delete this.phases[k]
    this.#scanned = 0
    this.#assets.reset()
    this.#emit({ type: 'build:start' })

    const config = this.#config ?? (await this.resolve())
    const diagnostics = new DiagnosticBag()

    if (config.output.clean) await cleanOutput(config)

    let documents = 0
    let cacheHits = 0
    this.#emitStats ??= createEmitStats(config.dryRun)
    const stats: EmitStats = this.#emitStats

    for (const collection of Object.values(config.collections)) {
      const result = await this.#time('collect+validate', () =>
        this.#buildCollection(collection, config, diagnostics)
      )
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
      join(config.output.dir, '.cache', 'assets.json'),
      config.dryRun
    )

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
      diagnostics: diagnostics.items
    }
    this.#emit({ type: 'build:end', result })
    return result
  }

  async #buildCollection(
    collection: CollectionDefinition,
    config: ResolvedConfig,
    diagnostics: DiagnosticBag
  ): Promise<{ entries: StoreEntry[]; cacheHits: number }> {
    const cachedEntries = this.#cache.get(collection.name) ?? []

    // A document whose IMAGE changed is stale even though its own file did not.
    // Velite invalidates only the edited content file, so a rebuilt site keeps
    // serving fingerprinted URLs for bytes that no longer exist.
    const previous = await this.#dropAssetStale(
      this.#previous.get(collection.name),
      cachedEntries
    )
    const collected = await this.#time('read', () => collectFiles(collection, config, previous))

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
        message: `No files matched in ${collection.directory}`,
        collection: collection.name,
        hint: `Pattern: ${String(collection.include)}`
      })
    }

    const cached = cachedEntries
    const cacheHits = collected.unchanged.length
    this.#scanned += cached.filter(e => collected.unchanged.includes(e.meta.filePath)).length

    const parsedGroups = await this.#time('parse+validate', () =>
      mapLimit(collected.files, config.concurrency, async file =>
        this.#processFile(file, collection, config, diagnostics)
      )
    )

    const fresh = parsedGroups.flat()

    // Only files we did NOT re-read may reuse a cached entry. Keying on every
    // path we saw would resurrect stale data whenever an edited file stopped
    // validating — the document would vanish from `fresh`, and its previous
    // version would silently survive into the output.
    const reusable = new Set(collected.unchanged)
    const entries: StoreEntry[] = cached.filter(e => reusable.has(e.meta.filePath))

    // Reused documents never re-register their assets, so readopt them or the
    // copier will delete files the emitted HTML still points at.
    for (const entry of entries) {
      if (entry.assets?.length) {
        this.#assets.adopt(`${collection.name}\u0000${entry.id}`, entry.assets)
      }
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
    if (collection.sort) {
      const docs = unique.map(e => ({ ...e.data, _meta: e.meta }))
      const order = unique.map((_, i) => i)
      const compare = collection.sort
      order.sort((x, y) => compare(docs[x]!, docs[y]!))
      unique.splice(0, unique.length, ...order.map(i => unique[i]!))
    }

    if (collection.single && unique.length !== 1) {
      diagnostics.add({
        code: 'CM_SINGLETON',
        severity: 'error',
        message: `Collection "${collection.name}" is \`single\` but matched ${unique.length} documents`,
        collection: collection.name,
        hint:
          unique.length === 0
            ? `No file matched ${String(collection.include)} in ${collection.directory}.`
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

  #reportUnknownFields(
    raw: Record<string, unknown>,
    validated: Record<string, unknown>,
    injectedBody: string | undefined,
    ctx: UnknownFieldContext
  ): void {
    reportUnknownFields(raw, validated, injectedBody, ctx)
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
  async #runTransform(
    collection: CollectionDefinition,
    validated: Record<string, unknown>,
    documentMeta: DocumentMeta,
    file: { relativePath: string; absolutePath: string; content: string },
    body: string,
    diagnostics: DiagnosticBag
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
      ...assets
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
  async #dropAssetStale(
    previous: Map<string, PreviousState> | undefined,
    cached: readonly StoreEntry[]
  ): Promise<Map<string, PreviousState> | undefined> {
    if (!previous) return previous
    const withAssets = cached.filter(e => e.assetDeps?.length)
    if (withAssets.length === 0) return previous

    let next: Map<string, PreviousState> | undefined
    for (const entry of withAssets) {
      if (await this.#assets.changed(entry.assetDeps!)) {
        next ??= new Map(previous)
        next.delete(entry.meta.filePath)
      }
    }
    return next ?? previous
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

  async #processFile(
    file: SourceFile,
    collection: CollectionDefinition,
    config: ResolvedConfig,
    diagnostics: DiagnosticBag
  ): Promise<StoreEntry[]> {
    const parser = resolveParser(
      file.extension || extname(file.relativePath),
      collection.parser,
      config.parsers
    )
    if (!parser) {
      this.#scanned += 1
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
      parsed = await parser.parse({ content: file.content, path: file.absolutePath })
    } catch (error) {
      // js-yaml (vendored by confbox) appends its own multi-line ASCII frame to
      // `.message`. Left alone it lands inside our tree with foreign
      // indentation and makes --json messages multi-line.
      this.#scanned += 1
      const { message, position } = normalizeParserError(error)
      diagnostics.add({
        code: 'CM_PARSE',
        severity: 'error',
        message,
        file: file.relativePath,
        collection: collection.name,
        ...(position ? { line: position.line, ...(position.column === undefined ? {} : { column: position.column }) } : {}),
        ...(position ? { frame: codeFrame(file.content, position) } : {}),
        hint: `Parsed with the "${parser.name}" parser.`
      })
      return []
    }

    const records = Array.isArray(parsed) ? parsed : [parsed]
    this.#scanned += records.length
    const meta = metaFor(file, collection.directory)
    const out: StoreEntry[] = []

    for (const [i, record] of records.entries()) {
      const many = records.length > 1
      const id = many ? `${meta.id}[${i}]` : meta.id
      const raw: Record<string, unknown> = { ...record.data }
      // Remember whether WE injected the body, so it is never reported as an
      // unknown field for a schema that simply does not want it.
      let injectedBody: string | undefined
      if (parser.hasBody && record.body !== undefined && !(BODY_FIELD in raw)) {
        raw[BODY_FIELD] = record.body
        injectedBody = BODY_FIELD
      }

      const policy = config.onValidationError
      const result = await validate(collection.schema, raw)

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
              ...(at ? { line: at.line, ...(at.column === undefined ? {} : { column: at.column }) } : {}),
              ...(at ? { frame: codeFrame(file.content, at) } : {}),
              collection: collection.name,
              documentId: id,
              ...hintFor(issue.path, known)
            })
          }
        }
        // Only 'warn' keeps the invalid document. Emitting a record that
        // violates its own declared type — velite's default — makes the
        // generated .d.ts a lie.
        if (policy !== 'warn') continue
      } else {
        this.#reportUnknownFields(raw, result.value, injectedBody, {
          file: file.relativePath,
          source: file.content,
          collection: collection.name,
          documentId: id,
          policy: config.onUnknownField,
          diagnostics
        })
      }

      const documentMeta = many ? { ...meta, id } : meta
      const validated = result.ok ? result.value : raw

      let data: Record<string, unknown> = validated
      if (collection.transform) {
        const transformed = await this.#runTransform(
          collection,
          validated,
          documentMeta,
          file,
          record.body ?? '',
          diagnostics
        )
        if (transformed === undefined) continue
        data = transformed
      }

      // The body already lives in `data` (under the parser's body field), so
      // keeping a second copy on the entry doubled resident memory for no gain.
      const ownerId = `${collection.name}\u0000${id}`
      const owned = this.#assets.ownedBy(ownerId)
      const assetDeps = owned.length === 0 ? undefined : this.#assets.dependencies(ownerId)
      out.push({
        id,
        collection: collection.name,
        digest: file.digest,
        emitKey:
          assetDeps === undefined
            ? file.digest
            : cacheKey(file.digest, ...assetDeps.map(d => d.digest)),
        data,
        meta: documentMeta,
        mtimeMs: file.mtimeMs,
        ...(assetDeps === undefined ? {} : { assets: owned, assetDeps })
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
