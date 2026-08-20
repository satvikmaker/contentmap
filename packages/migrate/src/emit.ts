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
 * Names contentmap refuses, because collection names become export names.
 *
 * Kept in step with the resolver's own list — a codemod that emits a config the
 * tool then rejects is worse than one that renames and says so.
 */
const RESERVED = new Set([
  'default',
  'import',
  'export',
  'const',
  'let',
  'var',
  'function',
  'class',
  'return',
  'new',
  'typeof',
  'void',
  'null',
  'true',
  'false',
  'await',
  'collection'
])

function toIdentifier(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^([0-9])/, '_$1')
  const safe = cleaned.length > 0 ? cleaned : 'collection'
  return RESERVED.has(safe) ? `${safe}_` : safe
}

/**
 * Make a plan emittable.
 *
 * Every problem fixed here produced a file that does not compile: a name with a
 * hyphen becomes `const my-posts`, two document types that pluralise alike
 * declare the same `const` twice, and an implicitly injected body field
 * collides with one the author already declared. All three are rare enough to
 * miss by hand and certain to waste someone's afternoon.
 */
export function normalizePlan(plan: EmitPlan): Note[] {
  const notes: Note[] = []
  const taken = new Set<string>()
  const typeNames = new Set<string>()

  for (const collection of plan.collections) {
    const wanted = toIdentifier(collection.key)
    if (wanted !== collection.key) {
      notes.push({
        kind: 'review',
        collection: collection.key,
        subject: 'name',
        message: `renamed to \`${wanted}\``,
        hint: 'Collection names become export names, so they have to be identifiers.'
      })
    }

    let unique = wanted
    for (let n = 2; taken.has(unique); n++) unique = `${wanted}${n}`
    if (unique !== wanted) {
      notes.push({
        kind: 'review',
        collection: wanted,
        subject: 'name',
        message: `renamed to \`${unique}\` — another collection already claimed \`${wanted}\``,
        hint: 'Two definitions produced the same name. Pick something meaningful for each.'
      })
    }
    taken.add(unique)
    collection.key = unique
    // `name` defaults to the key and is validated the same way, so it moves too.
    collection.name = unique

    // Type names have to be unique as well — contentmap refuses two collections
    // that would generate the same exported type, which is exactly what two
    // document types called `Post` produce.
    if (collection.typeName !== undefined) {
      const wantedType = collection.typeName
      let type = wantedType
      for (let n = 2; typeNames.has(type); n++) type = `${wantedType}${n}`
      if (type !== wantedType) {
        notes.push({
          kind: 'review',
          collection: unique,
          subject: 'typeName',
          message: `renamed to \`${type}\` — \`${wantedType}\` was already taken`,
          hint: 'Two definitions shared a type name. Give each a name that says what it is.'
        })
      }
      typeNames.add(type)
      collection.typeName = type
    }

    // Later wins: an implicit body field is added before the author's own, so
    // keeping the last one keeps what they actually wrote.
    const seen = new Map<string, number>()
    const fields: typeof collection.fields = []
    for (const field of collection.fields) {
      const at = seen.get(field.name)
      if (at === undefined) {
        seen.set(field.name, fields.length)
        fields.push(field)
        continue
      }
      fields[at] = field
      notes.push({
        kind: 'review',
        collection: unique,
        subject: field.name,
        message: 'was declared twice; the one from your config was kept',
        hint: 'contentmap injects the body as `content` unless the schema names it itself.'
      })
    }
    collection.fields = fields
  }
  return notes
}

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
