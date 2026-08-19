import { extname } from 'node:path'
import { DiagnosticBag } from './diagnostics.ts'
import { resolveConfig } from './config/resolve.ts'
import { collectFiles, metaFor, type PreviousState, type SourceFile } from './collect/read.ts'
import { resolveParser } from './parsers/index.ts'
import { validate } from './validate/standard.ts'
import {
  cleanOutput,
  createEmitStats,
  emitBarrel,
  emitCollection,
  emitTypes,
  type EmitStats
} from './write/emit.ts'
import { mapLimit } from './utils/limit.ts'
import { suggest } from './utils/paths.ts'
/** Field the frontmatter parsers write the document body into. */
const BODY_FIELD = 'content'

import type {
  BuilderEvent,
  BuilderOptions,
  BuildResult,
  CollectionDefinition,
  Diagnostic,
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
        emitCollection({ collection, entries: result.entries, config, stats })
      )
    }

    await emitBarrel(config, stats)
    await emitTypes(config, stats)

    for (const d of diagnostics.items) this.#emit({ type: 'diagnostic', diagnostic: d })

    const result: BuildResult = {
      collections: Object.keys(config.collections).length,
      documents,
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
    const previous = this.#previous.get(collection.name)
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

    const cached = this.#cache.get(collection.name) ?? []
    const cacheHits = collected.unchanged.length

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
      diagnostics.add({
        code: 'CM_PARSE',
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
        file: file.relativePath,
        collection: collection.name
      })
      return []
    }

    const records = Array.isArray(parsed) ? parsed : [parsed]
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
            diagnostics.add({
              code: 'CM_VALIDATION',
              // fail => error (build stops). warn/skip => warning (build
              // continues); they differ only in whether the document survives.
              severity: policy === 'fail' ? 'error' : 'warning',
              message: issue.message,
              file: file.relativePath,
              ...(issue.path === undefined ? {} : { field: issue.path }),
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
          collection: collection.name,
          documentId: id,
          policy: config.onUnknownField,
          diagnostics
        })
      }

      // The body already lives in `data` (under the parser's body field), so
      // keeping a second copy on the entry doubled resident memory for no gain.
      out.push({
        id,
        collection: collection.name,
        digest: file.digest,
        data: result.ok ? result.value : raw,
        meta: many ? { ...meta, id } : meta,
        mtimeMs: file.mtimeMs
      })
    }
    return out
  }
}

interface UnknownFieldContext {
  file: string
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
    ctx.diagnostics.add({
      code: 'CM_UNKNOWN_FIELD',
      severity: ctx.policy === 'fail' ? 'error' : 'warning',
      message: `"${key}" is not in the schema and was discarded`,
      file: ctx.file,
      field: key,
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
