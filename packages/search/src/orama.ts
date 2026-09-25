import type { AfterBuildContext, AfterBuildHook } from 'contentmap'
import { collect, optional, warnOnCorpus, type IndexOptions } from './core.ts'

export interface OramaOptions extends IndexOptions {
  /**
   * Orama schema types for the indexed fields. Defaults to `'string'`.
   *
   * Orama needs a declared type per field, and a field it has no type for is
   * simply not searchable — silently. Anything in `fields` gets `'string'`
   * unless named here.
   */
  schema?: Record<string, string>
}

interface OramaModule {
  create(options: { schema: Record<string, unknown> }): unknown
  insertMultiple(db: unknown, documents: readonly Record<string, unknown>[]): unknown
}
interface PersistenceModule {
  persist(db: unknown, format: string): Promise<string> | string
}

/**
 * An Orama index, written as one JSON file.
 *
 * Orama keeps whole documents and hands them back on every hit, so what is
 * inserted is what ships — the projection in `collect` is doing real work
 * here, not tidying. Restore it with:
 *
 * ```ts
 * import { restore } from '@orama/plugin-data-persistence'
 * const db = await restore('json', await fetch('/search.json').then(r => r.text()))
 * ```
 */
export function orama(options: OramaOptions): AfterBuildHook {
  return async (ctx: AfterBuildContext) => {
    warnOnCorpus(ctx, options, 'orama')
    const { create, insertMultiple } = await optional<OramaModule>('@orama/orama', 'orama()')
    const { persist } = await optional<PersistenceModule>(
      '@orama/plugin-data-persistence',
      'orama()'
    )

    const rows = collect(ctx, options)
    const declared: Record<string, unknown> = { id: 'string', collection: 'string' }
    for (const field of [...options.fields, ...(options.store ?? [])]) {
      declared[field] = options.schema?.[field] ?? 'string'
    }

    // create() is synchronous in Orama 3 and returned a promise before it;
    // awaiting covers both without pinning a major.
    const db = await create({ schema: declared })
    await insertMultiple(
      db,
      rows.map(row => ({ id: row.id, collection: row.collection, ...row.data }))
    )

    await ctx.writeFile(options.out, await persist(db, 'json'))
    ctx.logger.info(`orama: indexed ${rows.length} document(s) to ${options.out}`)
  }
}
