import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { digest as hashOf } from '../utils/digest.ts'
import { withFdRetry } from '../utils/fd.ts'
import { mapLimit } from '../utils/limit.ts'
import { expandTemplate, joinUrl } from './naming.ts'

const COPY_CONCURRENCY = 32

export interface RegisteredAsset {
  /** Public URL, suffix included. */
  src: string
  /** Emitted filename. */
  name: string
  sourcePath: string
  digest: string
  size: number
  buffer: Uint8Array
}

interface Entry {
  sourcePath: string
  digest: string
  size: number
  mtimeMs: number
}

/**
 * Registers assets during a build and copies them once at the end.
 *
 * Deferring the copy means a file referenced by fifty documents is read, hashed
 * and written exactly once, and the transform hot path stays pure. It also
 * gives us the ownership map, which is what makes deletion and invalidation
 * work rather than leaving orphans behind forever.
 */
export class AssetStore {
  /** name -> what to copy there. */
  #entries = new Map<string, Entry>()
  /** documentId -> names it referenced this build. */
  #owners = new Map<string, Set<string>>()
  /** absolute source path -> digest, for detecting a changed asset. */
  #digests = new Map<string, string>()
  /** Buffers held only until flush, so a copy never re-reads. */
  #buffers = new Map<string, Uint8Array>()
  /**
   * Every asset seen this session, surviving reset().
   *
   * A rebuild reuses cached documents, which never re-register their assets.
   * Without this the copier would see them as orphans and delete files the
   * emitted HTML still points at.
   */
  #known = new Map<string, Entry>()

  async register(options: {
    sourcePath: string
    template: string
    base: string
    suffix: string
    ownerId: string
  }): Promise<RegisteredAsset> {
    const { sourcePath, template, base, suffix, ownerId } = options
    const [buffer, info] = await Promise.all([
      withFdRetry(() => readFile(sourcePath)),
      stat(sourcePath)
    ])
    const digest = hashOf(buffer)
    const name = expandTemplate(template, sourcePath, digest)

    const entry: Entry = {
      sourcePath,
      digest,
      size: buffer.byteLength,
      mtimeMs: info.mtimeMs
    }
    this.#entries.set(name, entry)
    this.#known.set(name, entry)
    this.#buffers.set(name, buffer)
    this.#digests.set(sourcePath, digest)

    const owned = this.#owners.get(ownerId)
    if (owned) owned.add(name)
    else this.#owners.set(ownerId, new Set([name]))

    return {
      src: joinUrl(base, name) + suffix,
      name,
      sourcePath,
      digest,
      size: buffer.byteLength,
      buffer
    }
  }

  /** Assets a document referenced, for the store entry and for invalidation. */
  ownedBy(documentId: string): string[] {
    return [...(this.#owners.get(documentId) ?? [])].sort()
  }

  /** What a document depends on, for detecting a changed asset next build. */
  dependencies(documentId: string): AssetDependency[] {
    const out: AssetDependency[] = []
    for (const name of this.#owners.get(documentId) ?? []) {
      const entry = this.#entries.get(name)
      if (entry) {
        out.push({ path: entry.sourcePath, digest: entry.digest, mtimeMs: entry.mtimeMs })
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  /** Carry a cached document's assets forward so they are not treated as orphans. */
  adopt(documentId: string, names: readonly string[]): void {
    this.#owners.set(documentId, new Set(names))
    for (const name of names) {
      const entry = this.#known.get(name)
      if (entry) this.#entries.set(name, entry)
    }
  }

  /**
   * Has any of these files changed on disk?
   *
   * mtime first, because it is one stat against a read plus a hash; the digest
   * is only consulted when mtime moved, so a touched-but-identical file does
   * not invalidate anything.
   */
  async changed(deps: readonly AssetDependency[]): Promise<boolean> {
    for (const dep of deps) {
      const info = await stat(dep.path).catch(() => undefined)
      if (!info) return true
      if (info.mtimeMs === dep.mtimeMs) continue
      const buffer = await withFdRetry(() => readFile(dep.path)).catch(() => undefined)
      if (!buffer || hashOf(buffer) !== dep.digest) return true
    }
    return false
  }

  reset(): void {
    this.#entries.clear()
    this.#owners.clear()
    this.#buffers.clear()
  }

  /**
   * Copy everything registered, then delete anything in the directory that no
   * longer belongs.
   *
   * Velite never removes assets from deleted content, so a long-lived project
   * accumulates unreachable files in its public directory indefinitely.
   */
  async flush(outDir: string, dryRun = false): Promise<{ written: number; removed: number }> {
    if (dryRun) return { written: 0, removed: 0 }
    if (this.#entries.size === 0) {
      return { written: 0, removed: await this.#removeOrphans(outDir) }
    }
    await mkdir(outDir, { recursive: true })

    const names = [...this.#entries.keys()]
    let written = 0
    await mapLimit(names, COPY_CONCURRENCY, async name => {
      const target = join(outDir, name)
      // The filename contains the content hash, so a file already there with
      // the right size is already the right bytes.
      const entry = this.#entries.get(name)!
      const existing = await stat(target).catch(() => undefined)
      if (existing && existing.size === entry.size) return
      await mkdir(dirname(target), { recursive: true })
      const buffer = this.#buffers.get(name) ?? (await withFdRetry(() => readFile(entry.sourcePath)))
      await withFdRetry(() => writeFile(target, buffer))
      written++
    })

    this.#buffers.clear()
    return { written, removed: await this.#removeOrphans(outDir) }
  }

  async #removeOrphans(outDir: string): Promise<number> {
    const present = await readdir(outDir).catch(() => [] as string[])
    const stale = present.filter(name => !this.#entries.has(name))
    if (stale.length === 0) return 0
    await mapLimit(stale, COPY_CONCURRENCY, async name => {
      await rm(join(outDir, name), { force: true, recursive: true })
    })
    return stale.length
  }
}

export interface AssetDependency {
  path: string
  digest: string
  mtimeMs: number
}

export type { Entry as AssetEntry }
