import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { screenForSecrets } from '../security/secrets.ts'
import type { LoadedRecord, MetaStore } from './types.ts'

interface Persisted {
  meta: Record<string, string>
  records: LoadedRecord[]
}

/**
 * On-disk state for remote collections: revalidation tokens plus the last
 * successful payload.
 *
 * The snapshot is what makes an offline build, a 304 response and a frozen
 * build all cheap — none of them need to refetch or reparse. It is also why
 * everything written here is screened for credentials first: this file lives in
 * the repository's output directory and is the obvious place for a token to
 * leak into.
 */
export class RemoteStore {
  #dir: string
  #loaded = new Map<string, Persisted>()
  #dirty = new Set<string>()

  constructor(dir: string) {
    this.#dir = dir
  }

  async load(collection: string): Promise<Persisted> {
    const existing = this.#loaded.get(collection)
    if (existing) return existing
    let parsed: Persisted = { meta: {}, records: [] }
    try {
      const raw: unknown = JSON.parse(await readFile(this.#file(collection), 'utf8'))
      if (raw && typeof raw === 'object') parsed = { ...parsed, ...(raw as Persisted) }
    } catch {
      // absent or unreadable — a cold cache is not an error
    }
    this.#loaded.set(collection, parsed)
    return parsed
  }

  metaStore(collection: string): MetaStore {
    const state = this.#loaded.get(collection)!
    return {
      get: key => state.meta[key],
      set: (key, value) => {
        state.meta[key] = value
        this.#dirty.add(collection)
      },
      delete: key => {
        delete state.meta[key]
        this.#dirty.add(collection)
      }
    }
  }

  snapshot(collection: string): LoadedRecord[] | undefined {
    const state = this.#loaded.get(collection)
    return state && state.records.length > 0 ? state.records : undefined
  }

  save(collection: string, records: readonly LoadedRecord[]): void {
    const state = this.#loaded.get(collection)!
    state.records = [...records]
    this.#dirty.add(collection)
  }

  async flush(dryRun = false): Promise<void> {
    if (dryRun || this.#dirty.size === 0) return
    await mkdir(this.#dir, { recursive: true })
    for (const collection of this.#dirty) {
      const state = this.#loaded.get(collection)
      if (!state) continue
      // Refuse to persist anything that looks like a credential. Redacting
      // silently would leave the user believing a value round-trips when it
      // does not, so this is a build error.
      screenForSecrets(state, `remote cache for collection "${collection}"`)
      await writeFile(this.#file(collection), JSON.stringify(state), 'utf8')
    }
    this.#dirty.clear()
  }

  async drop(collection: string): Promise<void> {
    this.#loaded.delete(collection)
    this.#dirty.delete(collection)
    await rm(this.#file(collection), { force: true })
  }

  #file(collection: string): string {
    return join(this.#dir, `${collection.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
  }
}
