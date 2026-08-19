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
import type {
  BuilderEvent,
  BuilderOptions,
  BuildResult,
  CollectionDefinition,
  Diagnostic,
  ResolvedConfig,
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
  #emitStats: EmitStats = createEmitStats()

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
    const byId = new Map(cached.map(e => [e.id, e] as const))
    const cacheHits = collected.unchanged.length

    const parsedGroups = await this.#time('parse+validate', () =>
      mapLimit(collected.files, config.concurrency, async file =>
        this.#processFile(file, collection, config, diagnostics)
      )
    )

    const fresh = parsedGroups.flat()
    const alive = new Set(
      collected.unchanged.concat(collected.files.map(f => f.relativePath))
    )

    const entries: StoreEntry[] = []
    for (const entry of cached) {
      if (alive.has(entry.meta.filePath) && !fresh.some(f => f.id === entry.id)) {
        entries.push(entry)
      }
    }
    entries.push(...fresh)
    entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    this.#cache.set(collection.name, entries)
    this.#previous.set(
      collection.name,
      new Map(
        entries.map(e => [e.meta.filePath, { mtimeMs: e.mtimeMs, digest: e.digest }] as const)
      )
    )
    void byId
    return { entries, cacheHits }
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
      if (parser.hasBody && record.body !== undefined && !('content' in raw)) {
        raw['content'] = record.body
      }

      const result = await validate(collection.schema, raw)
      if (!result.ok) {
        const known = Object.keys(raw)
        for (const issue of result.issues) {
          diagnostics.add({
            code: 'CM_VALIDATION',
            severity: config.onValidationError === 'warn' ? 'warning' : 'error',
            message: issue.message,
            file: file.relativePath,
            ...(issue.path === undefined ? {} : { field: issue.path }),
            collection: collection.name,
            documentId: id,
            ...hintFor(issue.path, known)
          })
        }
        // 'warn' keeps the document; 'fail' and 'skip' both drop it. Emitting a
        // record that violates its own declared type — velite's default — makes
        // the generated .d.ts a lie.
        if (config.onValidationError !== 'warn') continue
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
