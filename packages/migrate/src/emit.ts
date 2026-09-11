import type { Node } from 'typescript'
import type { Carried } from './carry.ts'
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
  /** Emitted as the value of `transform`, if present. */
  transform?: string
}

/** An import the generated code needs for itself. */
export interface Import {
  module: string
  names: string[]
}

export interface EmitPlan {
  imports: Import[]
  collections: CollectionPlan[]
  /** Extra properties on defineConfig, already formatted as `key: value`. */
  configProps?: string[]
  notes: Note[]
  /**
   * Source nodes whose text the plan emits. Whatever they refer to at the top
   * of the original file comes along into the new one.
   */
  carry?: Node[]
  /** Packages the migration calls for, beyond contentmap and zod. */
  install?: string[]
  /** Tool imports the translation rewrites away, and how carried code follows. */
  vocabulary?: { names: ReadonlySet<string>; rewrite(code: string): string }
}

const quote = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

const list = (value: string | string[]): string =>
  Array.isArray(value) ? `[${value.map(quote).join(', ')}]` : quote(value)

/** A property key, quoted only when it has to be — `og-image` is not an identifier. */
export function propertyKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quote(name)
}

/**
 * Re-indent lifted code to where it now starts.
 *
 * Continuation lines keep their old indentation otherwise, and code lifted out
 * of a nested position then sits visibly wrong in a file that is the first
 * thing the user reads after migrating. The first line is left alone — the
 * caller has already placed it. Lines that begin inside a template literal are
 * part of a string, and re-indenting them would change the string.
 */
export function reindent(code: string, indent: string): string {
  const lines = code.split('\n')
  if (lines.length === 1) return code
  const inString: boolean[] = []
  let ticks = backticks(lines[0] ?? '')
  for (const line of lines.slice(1)) {
    inString.push(ticks % 2 === 1)
    ticks += backticks(line)
  }
  const rest = lines.slice(1)
  const margins = rest
    .filter((line, i) => !inString[i] && line.trim() !== '')
    .map(line => line.length - line.trimStart().length)
  const margin = margins.length > 0 ? Math.min(...margins) : 0
  return [
    lines[0] ?? '',
    ...rest.map((line, i) =>
      inString[i] ? line : line.trim() === '' ? '' : indent + line.slice(margin)
    )
  ].join('\n')
}

function backticks(line: string): number {
  let count = 0
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '`' && line[i - 1] !== '\\') count++
  }
  return count
}

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
 * hyphen becomes `const my-posts`, and two document types that pluralise alike
 * declare the same `const` twice. So does a collection named like something
 * carried over from the original config — `reserved` holds those names, and
 * the collection is the one that moves, because the carried code already
 * refers to its own.
 */
export function normalizePlan(plan: EmitPlan, reserved: ReadonlySet<string> = new Set()): Note[] {
  const notes: Note[] = []
  const taken = new Set<string>(reserved)
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
        message: reserved.has(wanted)
          ? `renamed to \`${unique}\` — \`${wanted}\` is already declared by code carried over from your config`
          : `renamed to \`${unique}\` — another collection already claimed \`${wanted}\``,
        hint: 'Two things produced the same name. Pick something meaningful for each.'
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
export function emitConfig(plan: EmitPlan, carried?: Carried): string {
  const out: string[] = []
  for (const { module, names } of plan.imports) {
    // Carried code that binds the same name wins: a config written against
    // `zod/v4` keeps its own `z`, and its schemas keep meaning what they did.
    const kept = names.filter(name => !carried?.names.has(name))
    if (kept.length > 0) out.push(`import { ${kept.join(', ')} } from ${quote(module)}`)
  }
  for (const line of carried?.imports ?? []) out.push(line)
  out.push('')

  for (const declaration of carried?.declarations ?? []) {
    out.push(declaration)
    out.push('')
  }

  for (const collection of plan.collections) {
    out.push(`const ${collection.key} = defineCollection({`)
    out.push(`  name: ${quote(collection.name)},`)
    if (collection.typeName) out.push(`  typeName: ${quote(collection.typeName)},`)
    if (collection.directory !== undefined) out.push(`  directory: ${quote(collection.directory)},`)
    if (collection.include !== undefined) out.push(`  include: ${list(collection.include)},`)
    if (collection.exclude !== undefined) out.push(`  exclude: ${list(collection.exclude)},`)
    if (collection.parser) out.push(`  parser: ${quote(collection.parser)},`)
    if (collection.single) out.push('  single: true,')

    if (collection.schema) {
      out.push(`  schema: ${reindent(collection.schema, '  ')},`)
    } else if (collection.fields.length === 0) {
      out.push('  schema: z.object({}),')
    } else {
      out.push('  schema: z.object({')
      collection.fields.forEach((field, i) => {
        const comma = i === collection.fields.length - 1 ? '' : ','
        out.push(`    ${propertyKey(field.name)}: ${reindent(field.expression, '    ')}${comma}`)
      })
      out.push('  }),')
    }

    if (collection.transform) {
      out.push(`  transform: ${reindent(collection.transform, '  ')}`)
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
  const inline = `export default defineConfig({ ${props.join(', ')} })`
  if (inline.length <= 100 && !inline.includes('\n')) {
    out.push(inline)
  } else {
    out.push('export default defineConfig({')
    props.forEach((p, i) => out.push(`  ${reindent(p, '  ')}${i === props.length - 1 ? '' : ','}`))
    out.push('})')
  }
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
