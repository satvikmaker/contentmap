import type { AfterBuildContext, AfterBuildHook } from 'contentmap'
import { collect, optional, warnOnCorpus, type IndexOptions } from './core.ts'

export interface MiniSearchOptions extends IndexOptions {
  /** Passed through to MiniSearch, minus the fields this already sets. */
  searchOptions?: Record<string, unknown>
}

interface MiniSearchModule {
  default: new (options: Record<string, unknown>) => {
    addAll(documents: readonly Record<string, unknown>[]): void
  }
}

/**
 * A MiniSearch index, written as one JSON file.
 *
 * The file holds `{ options, index }` rather than the bare index, because
 * `MiniSearch.loadJSON` has to be given the same options the index was built
 * with and will misbehave quietly if they drift. Shipping them together is the
 * only way a client cannot get that wrong:
 *
 * ```ts
 * const { options, index } = await fetch('/search.json').then(r => r.json())
 * const search = MiniSearch.loadJSON(JSON.stringify(index), options)
 * ```
 */
export function miniSearch(options: MiniSearchOptions): AfterBuildHook {
  return async (ctx: AfterBuildContext) => {
    warnOnCorpus(ctx, options, 'minisearch')
    const { default: MiniSearch } = await optional<MiniSearchModule>('minisearch', 'minisearch()')

    const rows = collect(ctx, options)
    const stored = [...new Set(['collection', ...(options.store ?? [])])]
    // `id` is ours, so it is never one of the user's fields.
    const built = {
      ...options.searchOptions,
      fields: [...options.fields],
      storeFields: stored,
      idField: 'id'
    }

    const index = new MiniSearch(built)
    index.addAll(
      rows.map(row => ({
        id: row.id,
        collection: row.collection,
        ...row.data
      }))
    )

    await ctx.writeFile(
      options.out,
      // The index is stringified by MiniSearch's own toJSON, then embedded as
      // a value so the options travel with it.
      `{"options":${JSON.stringify(built)},"index":${JSON.stringify(index)}}`
    )
    ctx.logger.info(`minisearch: indexed ${rows.length} document(s) to ${options.out}`)
  }
}
