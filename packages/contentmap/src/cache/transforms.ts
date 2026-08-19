import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cacheKey, stableStringify } from '../utils/digest.ts'
import { decode, encode } from './codec.ts'

type DocumentCache = Record<string, unknown>
type CollectionCache = Record<string, DocumentCache>

/**
 * On-disk cache for expensive work inside a transform.
 *
 * Keyed on the config digest as well as the input, so any semantic config
 * change invalidates everything without the user thinking about it.
 *
 * One file per collection rather than one per key: content-collections writes a
 * file per cache entry plus a mapping index, which at ten thousand documents is
 * tens of thousands of tiny files, and it never garbage-collects them — deleting
 * a document leaves its cache behind forever.
 */
export class TransformCache {
  #dir: string
  #configDigest: string
  #loaded = new Map<string, CollectionCache>()
  #next = new Map<string, CollectionCache>()
  #dirty = new Set<string>()

  constructor(dir: string, configDigest: string) {
    this.#dir = dir
    this.#configDigest = configDigest
  }

  keyFor(input: unknown, userKey: string | undefined): string {
    return cacheKey(this.#configDigest, stableStringify(input), userKey ?? '')
  }

  async #load(collection: string): Promise<CollectionCache> {
    const existing = this.#loaded.get(collection)
    if (existing) return existing
    let parsed: CollectionCache = {}
    try {
      const raw: unknown = JSON.parse(await readFile(this.#file(collection), 'utf8'))
      if (raw && typeof raw === 'object') parsed = raw as CollectionCache
    } catch {
      // absent or unreadable — a cold cache is not an error
    }
    this.#loaded.set(collection, parsed)
    return parsed
  }

  /** Run `fn` unless an identical call is already on disk. */
  async through<T>(
    collection: string,
    documentId: string,
    input: unknown,
    fn: () => Promise<T> | T,
    userKey?: string
  ): Promise<T> {
    const key = this.keyFor(input, userKey)
    const stored = await this.#load(collection)
    const hit = stored[documentId]?.[key]

    const target = this.#next.get(collection) ?? {}
    this.#next.set(collection, target)
    const doc = target[documentId] ?? {}
    target[documentId] = doc

    if (hit !== undefined) {
      doc[key] = hit
      return decode(hit) as T
    }

    const produced = await fn()
    doc[key] = encode(produced)
    this.#dirty.add(collection)
    return produced
  }

  /**
   * Carry a cached document's entries forward.
   *
   * A document that was not reprocessed never calls `through`, so without this
   * its entries would be dropped as unused and recomputed next build.
   */
  async retain(collection: string, documentId: string): Promise<void> {
    const stored = await this.#load(collection)
    const kept = stored[documentId]
    if (!kept) return
    const target = this.#next.get(collection) ?? {}
    this.#next.set(collection, target)
    target[documentId] = kept
  }

  /**
   * Persist, keeping only what this build used.
   *
   * Entries for documents that no longer exist simply are not written, which is
   * the garbage collection content-collections never performs.
   */
  async flush(dryRun = false): Promise<void> {
    if (dryRun) return
    for (const [collection, data] of this.#next) {
      const before = this.#loaded.get(collection)
      const changed =
        this.#dirty.has(collection) || before === undefined ||
        stableStringify(before) !== stableStringify(data)
      if (!changed) continue
      await mkdir(this.#dir, { recursive: true })
      await writeFile(this.#file(collection), JSON.stringify(data), 'utf8')
      this.#loaded.set(collection, data)
    }
    this.#dirty.clear()
  }

  /** Forget a collection entirely — used when it disappears from the config. */
  async drop(collection: string): Promise<void> {
    this.#loaded.delete(collection)
    this.#next.delete(collection)
    await rm(this.#file(collection), { force: true })
  }

  reset(): void {
    this.#next.clear()
    this.#dirty.clear()
  }

  #file(collection: string): string {
    return join(this.#dir, `${collection.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
  }
}
