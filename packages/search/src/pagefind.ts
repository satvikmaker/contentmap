import { posix } from 'node:path'
import type { AfterBuildContext, AfterBuildHook, AnyDocument } from 'contentmap'
import { collect, optional, type IndexOptions, type Row } from './core.ts'

export interface PagefindOptions extends IndexOptions {
  /** The URL a hit points at. Defaults to `/<_meta.path>`. */
  url?: (document: AnyDocument, collection: string) => string
  /** ISO 639-1. Pagefind requires one and picks its stemmer from it. */
  language?: string
  /** Facets, as Pagefind filters. Each value becomes an array of strings. */
  filters?: readonly string[]
}

interface PagefindModule {
  createIndex(): Promise<{ index: PagefindIndex; errors?: string[] }>
  close(): Promise<void>
}
interface PagefindIndex {
  addCustomRecord(record: {
    url: string
    content: string
    language: string
    meta?: Record<string, string>
    filters?: Record<string, string[]>
  }): Promise<{ errors?: string[] }>
  getFiles(): Promise<{ files: { path: string; content: Uint8Array }[]; errors?: string[] }>
}

/**
 * A Pagefind bundle, written into a directory.
 *
 * Pagefind is the option that scales: it chunks its index and a browser fetches
 * only the chunks a query touches, so the corpus never arrives in one payload
 * whatever is in it.
 *
 * The files are taken with `getFiles()` and written through `ctx.writeFile`
 * rather than letting Pagefind's own `writeFiles()` put them on disk. Writing
 * them itself would go around the byte-compare, around the atomic write, and —
 * the one that bites — around the watcher, which would see a directory full of
 * new files and start the build that produced them all over again.
 */
export function pagefind(options: PagefindOptions): AfterBuildHook {
  return async (ctx: AfterBuildContext) => {
    const pf = await optional<PagefindModule>('pagefind', 'pagefind()')
    const rows = collect(ctx, options)
    const language = options.language ?? 'en'

    const { index, errors: opened } = await pf.createIndex()
    report(ctx, opened, 'createIndex')
    try {
      for (const row of rows) {
        const { errors } = await index.addCustomRecord({
          url: options.url?.(row.data as AnyDocument, row.collection) ?? urlOf(row),
          // Pagefind takes one string; the searchable fields are joined in the
          // order they were declared.
          content: options.fields
            .map(field => text(row.data[field]))
            .filter(Boolean)
            .join('\n\n'),
          language,
          meta: strings(row, options.store ?? []),
          ...(options.filters?.length ? { filters: facets(row, options.filters) } : {})
        })
        report(ctx, errors, `addCustomRecord ${row.id}`)
      }

      const { files, errors } = await index.getFiles()
      report(ctx, errors, 'getFiles')
      for (const file of files) {
        await ctx.writeFile(posix.join(options.out, file.path), file.content)
      }
      ctx.logger.info(
        `pagefind: indexed ${rows.length} document(s) into ${files.length} file(s) under ${options.out}`
      )
    } finally {
      // Always: the binary is a child process, and in watch mode a leaked one
      // per rebuild adds up fast.
      await pf.close()
    }
  }
}

function urlOf(row: Row): string {
  const path = (row.data['_meta.path'] ??
    (row.data._meta as { path?: string } | undefined)?.path) as string | undefined
  return `/${path ?? row.id}`
}

/** Pagefind metadata is strictly flat strings; anything else is dropped loudly. */
function strings(row: Row, fields: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of fields) {
    const value = row.data[field]
    const as = text(value)
    if (as !== '') out[field] = as
  }
  return out
}

/** Filters are strictly flat arrays of strings. */
function facets(row: Row, fields: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const field of fields) {
    const value = row.data[field]
    if (value === undefined || value === null) continue
    const list = (Array.isArray(value) ? value : [value]).map(text).filter(Boolean)
    if (list.length > 0) out[field] = list
  }
  return out
}

/**
 * A scalar as Pagefind wants it.
 *
 * Its metadata is strictly flat strings, and frontmatter is full of numbers and
 * dates. Handed one as it is, Pagefind does not warn or skip the record — the
 * service throws, `invalid type: integer 3, expected a string`, and the build
 * fails on a message that names neither the document nor the field. A Date
 * becomes its ISO form, so it still sorts.
 */
function text(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(', ')
  return ''
}

function report(ctx: AfterBuildContext, errors: string[] | undefined, where: string): void {
  for (const error of errors ?? []) ctx.logger.warn(`pagefind ${where}: ${error}`)
}
