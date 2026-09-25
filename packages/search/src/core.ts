import { collectionNameOf } from 'contentmap'
import type { AfterBuildContext, AnyDocument, CollectionRef } from 'contentmap'

/**
 * Fields whose value is the document itself.
 *
 * The same list contentmap keeps out of its own index, for the same reason: a
 * search index that stores these is a copy of the corpus, and shipping the
 * corpus to a browser is the thing this project exists to avoid.
 */
export const HEAVY: readonly string[] = ['content', 'html', 'mdx', 'body', 'raw']

export interface IndexOptions {
  /** Collections to index. Pass the definitions rather than their names. */
  collections: readonly CollectionRef[]
  /**
   * Fields whose text is searchable.
   *
   * Indexing a heavy field is fine, and usually the point — an inverted index
   * holds terms, not prose. *Storing* one is what ships the corpus, which is
   * why these are two options and not one.
   */
  fields: readonly string[]
  /** Fields carried into a result, to render it with. Keep this small. */
  store?: readonly string[]
  /** Where to write: a file for minisearch and orama, a directory for pagefind. */
  out: string
  /** Identity of a document. Defaults to `<collection>/<_meta.id>`. */
  id?: (document: AnyDocument, collection: string) => string
  /** Index only the documents this keeps. */
  filter?: (document: AnyDocument, collection: string) => boolean
}

export interface Row {
  id: string
  collection: string
  /** Only what was asked for: `fields`, `store`, and the id. */
  data: Record<string, unknown>
}

/**
 * One row per document, projected to the fields the index actually needs.
 *
 * The projection is the guard. Handing whole documents to an engine that
 * stores what it is given — Orama keeps the document and returns it on every
 * hit — is how an index quietly becomes the corpus.
 */
export function collect(ctx: AfterBuildContext, options: IndexOptions): Row[] {
  const keep = [...new Set([...options.fields, ...(options.store ?? [])])]
  const rows: Row[] = []

  for (const ref of options.collections) {
    const name = collectionNameOf(ref)
    if (name === undefined) {
      throw new Error(
        'search: a collection could not be named. Pass the definition from your config, or its name as a string.'
      )
    }
    for (const document of ctx.documents(ref) as AnyDocument[]) {
      if (options.filter && !options.filter(document, name)) continue
      const data: Record<string, unknown> = {}
      for (const field of keep) {
        const value = read(document, field)
        if (value !== undefined) data[field] = value
      }
      rows.push({
        id: options.id?.(document, name) ?? `${name}/${document._meta.id}`,
        collection: name,
        data
      })
    }
  }
  return rows
}

/**
 * Say so when the index is about to become a copy of the content.
 *
 * A warning, not an error: a small corpus that genuinely wants its prose in
 * the payload is a legitimate choice and this is not the place to overrule it.
 * Silence is not legitimate, because the cost only shows up on someone's
 * phone.
 */
export function warnOnCorpus(ctx: AfterBuildContext, options: IndexOptions, what: string): void {
  const stored = (options.store ?? []).filter(field => HEAVY.includes(field))
  if (stored.length === 0) return
  ctx.logger.warn(
    `${what}: storing ${stored.join(', ')} puts the full text of every document in the index. ` +
      'Move it to `fields` to make it searchable without shipping it.'
  )
}

/** Dotted, so `_meta.path` works as a field name. */
function read(document: AnyDocument, path: string): unknown {
  if (!path.includes('.')) return (document as Record<string, unknown>)[path]
  let value: unknown = document
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

/** A missing optional peer should name itself, not surface as a bare resolver error. */
export async function optional<T>(name: string, what: string): Promise<T> {
  return (await import(name).catch(() => {
    throw new Error(
      `${what} requires the \`${name}\` package. Install it alongside @contentmap/search.`
    )
  })) as T
}
