import type { Field, Note } from './types.ts'

export interface CollectionPlan {
  /** Key in `collections`, and the export name consumers import. */
  key: string
  /** contentmap `name`, which defaults to the key. */
  name: string
  directory?: string
  include?: string | string[]
  exclude?: string | string[]
  single?: boolean
  typeName?: string
  parser?: string
  /**
   * Schema expression, emitted exactly as written.
   *
   * content-collections already validates with a Standard Schema, so its schema
   * is lifted rather than rebuilt — reconstructing a zod expression that was
   * already a zod expression can only lose detail.
   */
  schema?: string
  fields: Field[]
  /** Emitted verbatim as the body of `transform`, if present. */
  transform?: string
  /** Lines to place above the collection, e.g. a TODO. */
  comments?: string[]
}

export interface EmitPlan {
  imports: string[]
  collections: CollectionPlan[]
  /** Extra properties on defineConfig, already formatted as `key: value`. */
  configProps?: string[]
  notes: Note[]
}

const quote = (s: string): string => `'${s.replace(/'/g, "\\'")}'`

const list = (value: string | string[]): string =>
  Array.isArray(value) ? `[${value.map(quote).join(', ')}]` : quote(value)

/**
 * Render a contentmap config.
 *
 * Text rather than a printer over a synthetic AST: this file is the first thing
 * the user reads after migrating, and it has to look like something a person
 * wrote. A generated-looking config invites a rewrite, which defeats the point.
 */
export function emitConfig(plan: EmitPlan): string {
  const out: string[] = []
  for (const line of plan.imports) out.push(line)
  out.push('')

  for (const collection of plan.collections) {
    for (const comment of collection.comments ?? []) out.push(comment)
    out.push(`const ${collection.key} = defineCollection({`)
    out.push(`  name: ${quote(collection.name)},`)
    if (collection.typeName) out.push(`  typeName: ${quote(collection.typeName)},`)
    if (collection.directory !== undefined) out.push(`  directory: ${quote(collection.directory)},`)
    if (collection.include !== undefined) out.push(`  include: ${list(collection.include)},`)
    if (collection.exclude !== undefined) out.push(`  exclude: ${list(collection.exclude)},`)
    if (collection.parser) out.push(`  parser: ${quote(collection.parser)},`)
    if (collection.single) out.push('  single: true,')

    if (collection.schema) {
      out.push(`  schema: ${collection.schema},`)
    } else if (collection.fields.length === 0) {
      out.push('  schema: z.object({}),')
    } else {
      out.push('  schema: z.object({')
      collection.fields.forEach((field, i) => {
        const comma = i === collection.fields.length - 1 ? '' : ','
        out.push(`    ${field.name}: ${field.expression}${comma}`)
      })
      out.push('  }),')
    }

    if (collection.transform) {
      out.push(`  transform: ${collection.transform}`)
    }
    // Trim the trailing comma of the final property, and of the last schema
    // field: the generated file is the first thing the user reads, and a
    // formatter they already run should not immediately rewrite it.
    const last = out.length - 1
    out[last] = (out[last] ?? '').replace(/,$/, '')
    out.push('})')
    out.push('')
  }

  const keys = plan.collections.map(c => c.key)
  const props = [`collections: { ${keys.join(', ')} }`, ...(plan.configProps ?? [])]
  out.push(`export default defineConfig({ ${props.join(', ')} })`)
  return `${out.join('\n')}\n`
}

/** The report printed after a migration, and written beside the config. */
export function renderNotes(notes: readonly Note[]): string {
  if (notes.length === 0) return 'Nothing needs manual attention.\n'
  const order: Note['kind'][] = ['unsupported', 'manual', 'review']
  const heading: Record<Note['kind'], string> = {
    unsupported: 'No equivalent in contentmap',
    manual: 'Carried over as-is — check these',
    review: 'Converted, but worth a look'
  }
  const out: string[] = []
  for (const kind of order) {
    const group = notes.filter(n => n.kind === kind)
    if (group.length === 0) continue
    out.push(`## ${heading[kind]}`)
    out.push('')
    for (const note of group) {
      const where = note.collection ? `${note.collection}.${note.subject}` : note.subject
      out.push(`- **${where}** — ${note.message}`)
      if (note.hint) out.push(`  ${note.hint}`)
    }
    out.push('')
  }
  return out.join('\n')
}
