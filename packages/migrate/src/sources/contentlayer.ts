import { pluralize } from 'inflection'
import { isBoundWithin, isReference, topLevelBindings } from '../carry.ts'
import {
  propertyKey,
  reindent,
  type CollectionPlan,
  type ConfigProp,
  type EmitPlan,
  type Import
} from '../emit.ts'
import {
  afterBuildValue,
  callable as callableNode,
  objectLiteral,
  type HookSource
} from '../hook.ts'
import {
  booleanOf,
  callsTo,
  declarationOf,
  elementsOf,
  entriesOf,
  objectOf,
  prop,
  resolveArray,
  resolveObject,
  short,
  stringOf,
  text,
  ts,
  unwrap,
  type Entry
} from '../ts.ts'
import type { Field, Note } from '../types.ts'

/**
 * contentlayer is the furthest from contentmap, and the one people most need
 * to leave — it has been unmaintained since its sponsor withdrew.
 *
 * Its fields are a bespoke DSL rather than a schema library, so every field has
 * to be rebuilt as zod. That is the part worth automating: it is mechanical,
 * tedious, and easy to get subtly wrong by hand.
 *
 * The documents it produced have a shape application code depends on —
 * `body.raw`, `body.code`, the computed fields — so the generated transform
 * rebuilds that shape rather than contentmap's own. A migration that also
 * means rewriting every page is a migration nobody finishes.
 */

type ContentType = 'markdown' | 'mdx' | 'data'

const SCALARS: Record<string, string> = {
  string: 'z.string()',
  number: 'z.number()',
  boolean: 'z.boolean()',
  // contentlayer typed `json` as `any`, and the config's own computed fields
  // were written against that: z.unknown() made `doc.images[0]` a type error.
  json: 'z.any()'
}

/**
 * `_raw.<key>` and the contentmap spelling of the same value.
 *
 * Exact equivalents, not approximations — both are relative to the content
 * directory, and both strip the extension and a trailing `/index` from the
 * path. That is what makes rewriting them automatically safe. `_id` is the
 * path *with* its extension, so it is `filePath`, not `id`.
 */
const RAW: Record<string, string> = {
  flattenedPath: 'path',
  sourceFilePath: 'filePath',
  sourceFileName: 'fileName',
  sourceFileDir: 'directory'
}

/**
 * Calls whose result is certainly not a promise.
 *
 * contentlayer awaited every resolver, so a moved resolver is awaited unless
 * it plainly cannot produce a promise — `path.replace(…)` does not need an
 * `await` in front of it, and a reader would wonder why it had one.
 */
const SYNC_METHODS = new Set([
  'at',
  'charAt',
  'concat',
  'endsWith',
  'every',
  'filter',
  'find',
  'findIndex',
  'flat',
  'flatMap',
  'includes',
  'indexOf',
  'join',
  'lastIndexOf',
  'localeCompare',
  'map',
  'match',
  'normalize',
  'padEnd',
  'padStart',
  'reduce',
  'repeat',
  'replace',
  'replaceAll',
  'reverse',
  'slice',
  'some',
  'sort',
  'split',
  'startsWith',
  'substring',
  'toFixed',
  'toISOString',
  'toLowerCase',
  'toString',
  'toUpperCase',
  'trim',
  'trimEnd',
  'trimStart'
])
const SYNC_OWNERS = new Set([
  'Array',
  'Boolean',
  'Date',
  'Intl',
  'JSON',
  'Math',
  'Number',
  'Object',
  'String'
])
const SYNC_FUNCTIONS = new Set([
  'Boolean',
  'Number',
  'String',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'parseFloat',
  'parseInt'
])

/** Where a translation reports what it found. */
interface Sink {
  key: string
  notes: Note[]
  carry: ts.Node[]
  install: Set<string>
}

/** Names the generated transform declares, kept clear of the user's own. */
interface Locals {
  doc: string
  ctx: string
  body: string
  legacy: string
}

/** What a resolver needs to know about the document type it belongs to. */
interface Shape {
  typeName: string
  contentType: ContentType
  bodyField: string
  typeField: string
  locals: Locals
}

export function migrateContentlayer(file: ts.SourceFile): EmitPlan {
  const notes: Note[] = []
  const collections: CollectionPlan[] = []
  const carry: ts.Node[] = []
  const install = new Set<string>()
  const configProps: ConfigProp[] = []

  const source = callsTo(file, 'makeSource')[0]
  // `makeSource({ … })`, `makeSource(options)` and `makeSource(async () => ({ … }))`.
  const options = source
    ? (resolveObject(file, source.arguments[0]) ?? resolveObject(file, source))
    : undefined

  const dirExpr = options && prop(options, 'contentDirPath')
  const contentDir = stringOf(dirExpr) ?? 'content'
  if (dirExpr && stringOf(dirExpr) === undefined) {
    notes.push({
      kind: 'manual',
      subject: 'contentDirPath',
      message: `is computed (\`${short(dirExpr)}\`), so every collection reads from \`content\``,
      hint: 'Set `directory` on each collection to the path it evaluates to.'
    })
  }

  const fieldOptions = resolveObject(file, options && prop(options, 'fieldOptions'))
  const bodyField = stringOf(fieldOptions && prop(fieldOptions, 'bodyFieldName')) ?? 'body'
  const typeField = stringOf(fieldOptions && prop(fieldOptions, 'typeFieldName')) ?? 'type'
  const locals = localsFor(file)
  const exclude = contentDirExclude(file, options, notes)
  const contentTypes = new Set<ContentType>()
  /** contentlayer's export for each type — `allBlogs` — and the collection replacing it. */
  const exported: [string, string][] = []

  for (const entry of documentTypes(file, options, notes)) {
    const object = resolveObject(file, entry)
    if (!object) {
      notes.push({
        kind: 'manual',
        subject: short(entry),
        message: 'could not be followed to a document type',
        hint: 'Add it to the generated config by hand.'
      })
      continue
    }

    const typeName = stringOf(prop(object, 'name')) ?? 'Document'
    const key = collectionKey(typeName)
    const plan: CollectionPlan = { key, name: key, typeName, directory: contentDir, fields: [] }
    exported.push([exportName(typeName), key])
    const sink: Sink = { key, notes, carry, install }

    const pattern = prop(object, 'filePathPattern')
    const include = stringOf(pattern)
    if (include !== undefined) {
      plan.include = include
    } else {
      notes.push({
        kind: 'manual',
        collection: key,
        subject: 'filePathPattern',
        message: pattern ? `is computed (\`${short(pattern)}\`)` : 'is missing',
        hint: 'Set `include` to the glob it matches — contentmap needs one to find the files.'
      })
    }
    if (exclude) plan.exclude = exclude
    if (booleanOf(prop(object, 'isSingleton')) === true) plan.single = true

    const declared = stringOf(prop(object, 'contentType'))
    const contentType: ContentType =
      declared === 'mdx' || declared === 'data' ? declared : 'markdown'
    contentTypes.add(contentType)

    const fieldsExpr = prop(object, 'fields')
    const fields = resolveObject(file, fieldsExpr)
    if (fields) {
      plan.fields = translateFields(file, fields, sink, '')
    } else if (fieldsExpr) {
      notes.push({
        kind: 'manual',
        collection: key,
        subject: 'fields',
        message: `\`${short(fieldsExpr)}\` could not be followed to an object, so no field was carried over`,
        hint: 'Declare the schema by hand.'
      })
    }

    const computedExpr = prop(object, 'computedFields')
    const computedObject = resolveObject(file, computedExpr)
    let computed: Entry[] = []
    if (computedObject) {
      computed = entriesOf(file, computedObject, node =>
        notes.push(unfollowed(key, 'computedFields', node, 'transform'))
      )
    } else if (computedExpr) {
      notes.push(unfollowed(key, 'computedFields', computedExpr, 'transform'))
    }

    const shape: Shape = { typeName, contentType, bodyField, typeField, locals }
    const transform = buildTransform(file, computed, shape, sink)
    if (transform) plan.transform = transform
    if (contentType !== 'data') notes.push(bodyNote(key, shape))
    collections.push(plan)
  }

  const imports: Import[] = [
    { module: 'contentmap', names: ['defineCollection', 'defineConfig'] },
    { module: 'zod', names: ['z'] }
  ]
  if (contentTypes.has('mdx')) {
    imports.push({ module: '@contentmap/mdx', names: ['mdx'] })
    install.add('@contentmap/mdx')
    // contentlayer's body.code was an mdx-bundler bundle, rendered with
    // `getMDXComponent`. The compat output runs under that as well as run().
    const mdxOptions = pluginOptions(
      file,
      options && prop(options, 'mdx'),
      'mdx',
      ["compat: 'mdx-bundler'"],
      { notes, carry }
    )
    configProps.push(`mdx: mdx(${mdxOptions})`)
  }
  if (contentTypes.has('markdown')) {
    imports.push({ module: '@contentmap/unified', names: ['unifiedRenderer'] })
    install.add('@contentmap/unified')
    // contentlayer ran plain remark-parse, remark-rehype and rehype-stringify,
    // with neither GFM nor heading ids unless a plugin added them.
    const renderer = pluginOptions(
      file,
      options && prop(options, 'markdown'),
      'markdown',
      ['gfm: false', 'headingIds: false'],
      { notes, carry }
    )
    configProps.push(`renderer: unifiedRenderer(${renderer})`)
  }
  configProps.push(...policies(options, notes))

  // onSuccess did its work — a tag count, a search index — once the data was
  // generated, fetching it through `importData()`. afterBuild runs at the same
  // point, so the callback is kept as written and handed an importData that
  // returns contentmap's documents under the names contentlayer exported.
  const onSuccess = options && prop(options, 'onSuccess')
  if (onSuccess) {
    carry.push(onSuccess)
    const everything = /\ballDocuments\b/.test(text(onSuccess))
    const source: HookSource = {
      fn: onSuccess,
      comment: "contentlayer's importData(), rebuilt from contentmap's documents",
      argument: (names, ctx) => {
        const of = (key: string) => `${ctx}.documents('${names.get(key) ?? key}')`
        const entries: [string, string][] = exported.map(([all, key]) => [all, of(key)])
        if (everything) {
          entries.push([
            'allDocuments',
            `[${exported.map(([, key]) => `...${of(key)}`).join(', ')}]`
          ])
        }
        return `async () => (${objectLiteral(entries)})`
      }
    }
    configProps.push(names => `afterBuild: ${afterBuildValue([source], names)}`)
    notes.push({
      kind: 'review',
      subject: 'onSuccess',
      message: 'became `afterBuild`, called with the `importData()` it expects',
      hint:
        "Its documents are contentmap's: `_raw` and `_id` live on `_meta` now " +
        '(`_raw.flattenedPath` is `_meta.path`). `writeFileSync` still works; `ctx.writeFile` ' +
        'also skips unchanged files and never triggers a rebuild.'
    })
  }
  otherOptions(file, options, notes)

  return { imports, collections, configProps, notes, carry, install: [...install] }
}

/**
 * The collection key for a type name.
 *
 * contentlayer exports `all` + the plural of each type name, computed by the
 * `inflection` package. The same package decides here, so the key matches the
 * name the application already imports: `Authors` stays `authors` rather than
 * becoming `authorses`, and `Person` becomes `people`.
 */
function collectionKey(typeName: string): string {
  const plural = pluralize(typeName)
  return plural.charAt(0).toLowerCase() + plural.slice(1)
}

/** What contentlayer exported a type as: `all` + its plural, first letter raised. */
function exportName(typeName: string): string {
  const plural = pluralize(typeName)
  return `all${plural.charAt(0).toUpperCase()}${plural.slice(1)}`
}

function documentTypes(
  file: ts.SourceFile,
  options: ts.ObjectLiteralExpression | undefined,
  notes: Note[]
): ts.Expression[] {
  const declared = options && prop(options, 'documentTypes')
  const unfollowedType = (node: ts.Node): void => {
    notes.push({
      kind: 'manual',
      subject: 'documentTypes',
      message: `\`${short(node)}\` could not be followed, so the types it holds were not migrated`,
      hint: 'Add them to the generated config by hand.'
    })
  }
  const array = resolveArray(file, declared)
  if (array) return elementsOf(file, array, unfollowedType)
  // contentlayer also takes a record: `documentTypes: { Post, Page }`.
  const record = objectOf(declared) ?? recordOf(file, declared)
  if (record) return entriesOf(file, record, unfollowedType).map(entry => entry.value)
  if (declared) {
    notes.push({
      kind: 'manual',
      subject: 'documentTypes',
      message: `\`${short(declared)}\` could not be followed, so every defineDocumentType in the file was migrated instead`,
      hint: 'Remove any the site does not use.'
    })
  }
  return callsTo(file, 'defineDocumentType')
}

function recordOf(
  file: ts.SourceFile,
  node: ts.Expression | undefined
): ts.ObjectLiteralExpression | undefined {
  const inner = unwrap(node)
  if (!inner || !ts.isIdentifier(inner)) return undefined
  return objectOf(declarationOf(file, inner.text)?.initializer)
}

function translateFields(
  file: ts.SourceFile,
  fields: ts.ObjectLiteralExpression,
  sink: Sink,
  path: string
): Field[] {
  const out: Field[] = []
  const entries = entriesOf(file, fields, node =>
    sink.notes.push(unfollowed(sink.key, `${path}fields`, node, 'schema'))
  )
  for (const entry of entries) {
    const name = `${path}${entry.name}`
    const def = resolveObject(file, entry.value)
    if (!def) {
      // Kept, accepting anything, rather than dropped: a dropped field turns
      // every document's value into an unknown-field warning.
      sink.notes.push({
        kind: 'manual',
        collection: sink.key,
        subject: name,
        message: `\`${short(entry.value)}\` could not be followed to a field definition, so it accepts anything`,
        hint: 'Give it a real schema.'
      })
      out.push({ name: entry.name, expression: 'z.unknown()' })
      continue
    }

    let expression = fieldType(file, def, sink, name)
    const defaultValue = prop(def, 'default')
    if (defaultValue) {
      expression = `${expression}.default(${text(defaultValue)})`
      sink.carry.push(defaultValue)
    } else if (booleanOf(prop(def, 'required')) !== true) {
      expression = `${expression}.optional()`
    }
    out.push({ name: entry.name, expression })
  }
  return out
}

/** A field definition's type as zod, without its optionality. */
function fieldType(
  file: ts.SourceFile,
  def: ts.ObjectLiteralExpression,
  sink: Sink,
  name: string
): string {
  const type = stringOf(prop(def, 'type')) ?? 'string'
  switch (type) {
    case 'enum': {
      const options = resolveArray(file, prop(def, 'options'))
      if (options) {
        sink.carry.push(options)
        return `z.enum([${options.elements.map(e => text(e)).join(', ')}])`
      }
      sink.notes.push({
        kind: 'review',
        collection: sink.key,
        subject: name,
        message: 'enum options were not a literal array, so it became z.string()',
        hint: 'Narrow it by hand if the values are known.'
      })
      return 'z.string()'
    }
    case 'list':
      return `z.array(${elementType(file, prop(def, 'of'), sink, name)})`
    case 'nested': {
      const of = resolveObject(file, prop(def, 'of'))
      if (of) return nestedObject(file, of, sink, name, false)
      sink.notes.push({
        kind: 'manual',
        collection: sink.key,
        subject: name,
        message: 'the nested type could not be followed, so it accepts anything',
        hint: 'Inline its shape as a `z.object({ … })`.'
      })
      return 'z.unknown()'
    }
    case 'reference':
      sink.notes.push({
        kind: 'review',
        collection: sink.key,
        subject: name,
        message: 'became z.string() holding the referenced id',
        hint:
          'Resolve it in a transform with `ctx.documents("<collection>")`, which is how ' +
          'contentmap does cross-collection references.'
      })
      return 'z.string()'
    case 'image':
      sink.install.add('@contentmap/image')
      sink.notes.push({
        kind: 'manual',
        collection: sink.key,
        subject: name,
        message: 'images are handled in a transform',
        hint: `Call \`ctx.image(doc.${name})\` in transform. Needs @contentmap/image.`
      })
      return 'z.string()'
    case 'date':
      sink.notes.push({
        kind: 'review',
        collection: sink.key,
        subject: name,
        message: 'was an ISO string in contentlayer; it is a `Date` here',
        hint:
          'Code that expects a string — `formatDate(date: string)`, comparing dates as strings — ' +
          'needs updating. To keep the string, use `z.coerce.date().transform(d => d.toISOString())`.'
      })
      return 'z.coerce.date()'
    case 'markdown':
    case 'mdx':
      sink.notes.push({
        kind: 'manual',
        collection: sink.key,
        subject: name,
        message: `contentlayer rendered this field into \`{ raw, ${type === 'mdx' ? 'code' : 'html'} }\`; it is the plain string here`,
        hint: 'contentmap renders the document body, not individual fields. Render it in transform.'
      })
      return 'z.string()'
    default: {
      const scalar = SCALARS[type]
      if (scalar) return scalar
      sink.notes.push({
        kind: 'review',
        collection: sink.key,
        subject: name,
        message: `unrecognised field type "${type}", so it became z.unknown()`
      })
      return 'z.unknown()'
    }
  }
}

/** The element type of a `list`, which may be a field, a nested type, or several. */
function elementType(
  file: ts.SourceFile,
  of: ts.Expression | undefined,
  sink: Sink,
  name: string
): string {
  const report = (message: string): string => {
    sink.notes.push({
      kind: 'review',
      collection: sink.key,
      subject: name,
      message,
      hint: 'Give the array a real element type.'
    })
    return 'z.unknown()'
  }
  if (!of) return report('list element type is missing, so it became z.array(z.unknown())')

  // `of: [Image, Video]` is a list mixing nested types, told apart by `type`.
  const mixed = resolveArray(file, of)
  if (mixed) {
    const members = elementsOf(file, mixed, () => undefined).map(member => {
      const object = resolveObject(file, member)
      return object ? nestedObject(file, object, sink, name, true) : 'z.unknown()'
    })
    return members.length === 1 ? (members[0] ?? 'z.unknown()') : `z.union([${members.join(', ')}])`
  }

  const object = resolveObject(file, of)
  if (!object)
    return report('list element type was not a plain object, so it became z.array(z.unknown())')
  // A nested type named directly — `of: Tag` — rather than a field definition.
  if (prop(object, 'fields') !== undefined) return nestedObject(file, object, sink, name, false)
  return fieldType(file, object, sink, `${name}[]`)
}

function nestedObject(
  file: ts.SourceFile,
  type: ts.ObjectLiteralExpression,
  sink: Sink,
  name: string,
  discriminated: boolean
): string {
  const fieldsObject = resolveObject(file, prop(type, 'fields'))
  const fields = fieldsObject ? translateFields(file, fieldsObject, sink, `${name}.`) : []
  const typeName = stringOf(prop(type, 'name'))
  // In a mixed list contentlayer reads `type` to tell the members apart, so the
  // frontmatter already carries it and the schema has to accept it.
  if (discriminated && typeName !== undefined) {
    fields.unshift({ name: 'type', expression: `z.literal(${literal(typeName)})` })
  }
  if (fields.length === 0) return 'z.object({})'
  const inline = `z.object({ ${fields.map(f => `${propertyKey(f.name)}: ${f.expression}`).join(', ')} })`
  if (inline.length <= 72 && !inline.includes('\n')) return inline
  const lines = fields.map((field, i) => {
    const comma = i === fields.length - 1 ? '' : ','
    return `  ${propertyKey(field.name)}: ${reindent(field.expression, '  ')}${comma}`
  })
  return ['z.object({', ...lines, '})'].join('\n')
}

/**
 * computedFields become one transform, which also rebuilds the body.
 *
 * A resolver written as a single expression is inlined with the document shape
 * rewritten onto contentmap's context. Anything else — a block body, a named
 * function, a destructured parameter — is called exactly as written, with an
 * object in the shape contentlayer passed it. Nothing is left as a TODO: both
 * forms run.
 */
function buildTransform(
  file: ts.SourceFile,
  computed: readonly Entry[],
  shape: Shape,
  sink: Sink
): string | undefined {
  const hasBody = shape.contentType !== 'data'
  const props: string[] = []
  let legacy = false
  let awaits = hasBody

  for (const entry of computed) {
    const subject = `computedFields.${entry.name}`
    const def = resolveObject(file, entry.value)
    const resolver = def && prop(def, 'resolve')
    if (!resolver) {
      sink.notes.push({
        kind: 'manual',
        collection: sink.key,
        subject,
        message: def
          ? 'had no `resolve` function to carry over'
          : `\`${short(entry.value)}\` could not be followed to a definition`,
        hint: 'Add it to transform by hand.'
      })
      continue
    }
    sink.carry.push(resolver)
    const moved = moveResolver(resolver, shape)
    legacy ||= moved.legacy
    awaits ||= moved.awaited
    props.push(`${propertyKey(entry.name)}: ${moved.text}`)
    sink.notes.push({ kind: 'review', collection: sink.key, subject, ...describe(moved) })
  }
  if (!hasBody && props.length === 0) return undefined

  const { doc, ctx, body } = shape.locals
  const head = `${awaits ? 'async ' : ''}(${doc}, ${ctx}) =>`
  if (!hasBody && !legacy) {
    const lines = [`${head} ({`, `    ...${doc},`, ...props.map(p => `    ${reindent(p, '    ')},`)]
    return [...withoutTrailingComma(lines), '  })'].join('\n')
  }

  const lines = [`${head} {`]
  if (hasBody) {
    const rendered =
      shape.contentType === 'mdx' ? `code: await ${ctx}.mdx()` : `html: await ${ctx}.markdown()`
    lines.push(`    const ${body} = { raw: ${ctx}.body, ${rendered} }`)
  }
  if (legacy) lines.push(...legacyShape(shape))
  lines.push('    return {', `      ...${doc},`)
  if (hasBody) {
    lines.push(
      `      ${shape.bodyField === body ? body : `${propertyKey(shape.bodyField)}: ${body}`},`
    )
  }
  for (const p of props) lines.push(`      ${reindent(p, '      ')},`)
  return [...withoutTrailingComma(lines), '    }', '  }'].join('\n')
}

function withoutTrailingComma(lines: string[]): string[] {
  const last = lines.length - 1
  lines[last] = (lines[last] ?? '').replace(/,$/, '')
  return lines
}

interface Moved {
  text: string
  /** Called with the contentlayer-shaped document rather than inlined. */
  legacy: boolean
  awaited: boolean
  applied: readonly string[]
}

function moveResolver(resolver: ts.Expression, shape: Shape): Moved {
  const fn = unwrap(resolver)
  if (fn && ts.isArrowFunction(fn) && !ts.isBlock(fn.body) && fn.parameters.length <= 1) {
    const first = fn.parameters[0]
    const param =
      first === undefined ? undefined : ts.isIdentifier(first.name) ? first.name.text : null
    if (param !== null) {
      // `doc => ({ … })`: the parentheses only mattered to the arrow.
      const body =
        ts.isParenthesizedExpression(fn.body) && ts.isObjectLiteralExpression(fn.body.expression)
          ? fn.body.expression
          : fn.body
      const rewritten = rewriteDocument(body, param, shape)
      if (rewritten) {
        const awaited = yieldsCall(body)
        return {
          text: awaited ? awaitOf(body, rewritten.text) : rewritten.text,
          legacy: false,
          // An `async doc => (await x).y` resolver inlines an `await`, which
          // only parses inside an async transform.
          awaited: awaited || awaitsDirectly(body),
          applied: rewritten.applied
        }
      }
    }
  }
  return {
    text: `await ${callable(resolver)}(${shape.locals.legacy})`,
    legacy: true,
    awaited: true,
    applied: []
  }
}

function describe(moved: Moved): Pick<Note, 'message' | 'hint'> {
  if (moved.legacy) {
    return {
      message: 'is called as written, with a document shaped the way contentlayer shaped it',
      hint:
        'It runs unchanged. To simplify it: `_raw.flattenedPath` is `ctx.meta.path`, ' +
        '`_id` is `ctx.meta.filePath`, `body.raw` is `ctx.body`.'
    }
  }
  if (moved.applied.length > 0) {
    return {
      message: `rewritten onto the contentmap context (${moved.applied.join('; ')})`,
      hint: 'Check it reads the way you intended.'
    }
  }
  return { message: 'moved into transform unchanged' }
}

/**
 * Rewrite a resolver's reads of its document parameter.
 *
 * On the syntax tree rather than the text, so `doc` inside a string, a
 * property named `doc`, or an inner function's own `doc` parameter is left
 * alone. Returns undefined when the document is used whole — passed to a
 * function, say — because then only the contentlayer-shaped object will do.
 */
function rewriteDocument(
  expr: ts.Expression,
  param: string | undefined,
  shape: Shape
): { text: string; applied: string[] } | undefined {
  const base = expr.getStart()
  const edits: { start: number; end: number; replacement: string }[] = []
  const applied = new Set<string>()
  const { ctx, doc, body } = shape.locals
  let whole = false

  const visit = (node: ts.Node): void => {
    if (whole) return
    if (
      param !== undefined &&
      ts.isIdentifier(node) &&
      node.text === param &&
      isReference(node) &&
      !isBoundWithin(node, expr)
    ) {
      const chain: string[] = []
      let top: ts.Node = node
      while (ts.isPropertyAccessExpression(top.parent) && top.parent.expression === top) {
        chain.push(top.parent.name.text)
        top = top.parent
      }
      const replace = (depth: number, replacement: string, description?: string): void => {
        let target: ts.Node = node
        for (let i = 0; i < depth; i++) target = target.parent
        edits.push({ start: target.getStart() - base, end: target.getEnd() - base, replacement })
        if (description) applied.add(description)
      }
      const [first, second] = chain
      if (first === undefined) {
        whole = true
      } else if (first === '_raw') {
        const mapped = second === undefined ? undefined : RAW[second]
        if (second === 'contentType') {
          replace(2, literal(shape.contentType), `_raw.contentType -> '${shape.contentType}'`)
        } else if (mapped) {
          replace(2, `${ctx}.meta.${mapped}`, `_raw.${second} -> ctx.meta.${mapped}`)
        } else {
          whole = true
        }
      } else if (first === '_id') {
        replace(1, `${ctx}.meta.filePath`, '_id -> ctx.meta.filePath')
      } else if (first === shape.typeField) {
        replace(1, literal(shape.typeName), `${shape.typeField} -> '${shape.typeName}'`)
      } else if (first === shape.bodyField && shape.contentType !== 'data') {
        replace(1, body)
      } else if (param !== doc) {
        replace(0, doc)
      }
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(expr)
  if (whole) return undefined

  let out = expr.getText()
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end)
  }
  return { text: out, applied: [...applied] }
}

/** Whether an expression can evaluate to a call's result, and so to a promise. */
function yieldsCall(node: ts.Expression): boolean {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return yieldsCall(node.expression)
  }
  if (ts.isCallExpression(node)) return !isKnownSync(node)
  if (ts.isTaggedTemplateExpression(node)) return true
  if (ts.isConditionalExpression(node))
    return yieldsCall(node.whenTrue) || yieldsCall(node.whenFalse)
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return yieldsCall(node.left) || yieldsCall(node.right)
    }
    if (op === ts.SyntaxKind.CommaToken) return yieldsCall(node.right)
  }
  return false
}

/** An `await` in the expression itself, not inside a function nested in it. */
function awaitsDirectly(node: ts.Node): boolean {
  if (ts.isAwaitExpression(node)) return true
  if (ts.isFunctionLike(node)) return false
  return ts.forEachChild(node, awaitsDirectly) ?? false
}

function isKnownSync(call: ts.CallExpression): boolean {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return SYNC_FUNCTIONS.has(callee.text)
  if (ts.isPropertyAccessExpression(callee)) {
    if (ts.isIdentifier(callee.expression) && SYNC_OWNERS.has(callee.expression.text)) return true
    return SYNC_METHODS.has(callee.name.text)
  }
  return false
}

function awaitOf(node: ts.Expression, code: string): string {
  const bare =
    ts.isCallExpression(node) ||
    ts.isTaggedTemplateExpression(node) ||
    ts.isParenthesizedExpression(node)
  return bare ? `await ${code}` : `await (${code})`
}

/** A resolver as something that can be called, whatever form it was written in. */
function callable(resolver: ts.Expression): string {
  return callableNode((unwrap(resolver) ?? resolver) as ts.Node)
}

/** The object contentlayer passed to `resolve`, rebuilt from contentmap's context. */
function legacyShape(shape: Shape): string[] {
  const { ctx, doc, body, legacy } = shape.locals
  const lines = [
    '    // What contentlayer passed to `resolve`, for resolvers kept exactly as written',
    `    const ${legacy} = {`,
    `      ...${doc},`,
    `      _id: ${ctx}.meta.filePath,`,
    '      _raw: {',
    `        sourceFilePath: ${ctx}.meta.filePath,`,
    `        sourceFileName: ${ctx}.meta.fileName,`,
    `        sourceFileDir: ${ctx}.meta.directory,`,
    `        contentType: ${literal(shape.contentType)},`,
    `        flattenedPath: ${ctx}.meta.path`,
    '      },',
    `      ${propertyKey(shape.typeField)}: ${literal(shape.typeName)}`
  ]
  if (shape.contentType !== 'data') {
    lines[lines.length - 1] += ','
    lines.push(
      `      ${shape.bodyField === body ? body : `${propertyKey(shape.bodyField)}: ${body}`}`
    )
  }
  lines.push('    }')
  return lines
}

function bodyNote(key: string, shape: Shape): Note {
  if (shape.contentType === 'mdx') {
    return {
      kind: 'review',
      collection: key,
      subject: shape.bodyField,
      message:
        'rebuilt the way contentlayer shaped it — `raw` and `code` — and compiled by @contentmap/mdx',
      hint:
        "`code` runs under mdx-bundler's `getMDXComponent`, so `useMDXComponent(post.body.code)` " +
        'keeps working, and so does `run()` from @mdx-js/mdx. Imports inside .mdx files are not ' +
        'bundled; pass those components when rendering.'
    }
  }
  return {
    kind: 'review',
    collection: key,
    subject: shape.bodyField,
    message:
      'rebuilt the way contentlayer shaped it — `raw` and `html` — and rendered by ' +
      '@contentmap/unified with the same remark and rehype plugins'
  }
}

/** `mdx` or `markdown` options, as the argument to `mdx()` or `unifiedRenderer()`. */
function pluginOptions(
  file: ts.SourceFile,
  expr: ts.Expression | undefined,
  kind: 'mdx' | 'markdown',
  fixed: readonly string[],
  sink: { notes: Note[]; carry: ts.Node[] }
): string {
  const props = [...fixed]
  const object = resolveObject(file, expr)
  if (expr && !object) {
    sink.notes.push({
      kind: 'manual',
      subject: kind,
      message: `\`${short(expr)}\` is not an options object, so none of it was carried over`,
      hint:
        kind === 'markdown'
          ? 'Pass the same remark and rehype plugins to `unifiedRenderer()`.'
          : 'Pass the same remark and rehype plugins to `mdx()`.'
    })
  }
  if (object) {
    const entries = entriesOf(file, object, node =>
      sink.notes.push({
        kind: 'manual',
        subject: kind,
        message: `\`${short(node)}\` could not be followed, so the options it adds were not carried over`,
        hint: 'Add them by hand.'
      })
    )
    for (const entry of entries) {
      if (entry.name === 'remarkPlugins' || entry.name === 'rehypePlugins') {
        props.push(`${entry.name}: ${text(entry.value)}`)
        sink.carry.push(entry.value)
      } else if (entry.name === 'cwd' || entry.name === 'resolveCwd') {
        sink.notes.push({
          kind: 'review',
          subject: `${kind}.${entry.name}`,
          message: 'dropped',
          hint: 'Each file is compiled with its own path, so relative references resolve against it.'
        })
      } else {
        sink.notes.push({
          kind: 'manual',
          subject: `${kind}.${entry.name}`,
          message:
            kind === 'mdx'
              ? 'has no equivalent — @contentmap/mdx compiles with @mdx-js/mdx rather than bundling with esbuild'
              : 'has no equivalent in @contentmap/unified',
          hint: 'Not carried over.'
        })
      }
    }
  }
  if (props.length === 0) return ''
  const inline = `{ ${props.join(', ')} }`
  if (inline.length <= 60 && !inline.includes('\n')) return inline
  // Written for a call that starts two spaces in, as it does inside defineConfig.
  const lines = props.map(
    (p, i) => `    ${reindent(p, '    ')}${i === props.length - 1 ? '' : ','}`
  )
  return ['{', ...lines, '  }'].join('\n')
}

/**
 * contentlayer's validation policies, translated.
 *
 * `onExtraFieldData` maps word for word. `onMissingOrIncompatibleData` does
 * not: contentlayer's default skipped an invalid document with a warning,
 * where contentmap fails the build. The stricter default stays — a document
 * vanishing from a site is exactly what a build should refuse to do quietly —
 * but the report says so, with the one line that restores the old behaviour.
 */
function policies(options: ts.ObjectLiteralExpression | undefined, notes: Note[]): string[] {
  const out: string[] = []
  const missing = stringOf(options && prop(options, 'onMissingOrIncompatibleData'))
  if (missing === undefined) {
    notes.push({
      kind: 'review',
      subject: 'onValidationError',
      message:
        'contentlayer skipped a document that failed validation and printed a warning; contentmap fails the build instead',
      hint: "Keep the default and fix what it reports, or set `onValidationError: 'skip'` for contentlayer's behaviour."
    })
  } else {
    const mapped = (
      { 'skip-warn': 'skip', skip: 'ignore', fail: 'fail' } as Record<string, string>
    )[missing]
    if (mapped && mapped !== 'fail') out.push(`onValidationError: '${mapped}'`)
    notes.push({
      kind: 'review',
      subject: 'onMissingOrIncompatibleData',
      message: mapped
        ? `\`'${missing}'\` became \`onValidationError: '${mapped}'\``
        : `\`'${missing}'\` has no equivalent, so contentmap's default applies`
    })
  }

  const extra = stringOf(options && prop(options, 'onExtraFieldData'))
  if (extra === 'ignore' || extra === 'fail' || extra === 'warn') {
    if (extra !== 'warn') out.push(`onUnknownField: '${extra}'`)
    notes.push({
      kind: 'review',
      subject: 'onExtraFieldData',
      message: `became \`onUnknownField: '${extra}'\``
    })
  }
  return out
}

const HANDLED = new Set([
  'contentDirPath',
  'contentDirExclude',
  'documentTypes',
  'fieldOptions',
  'markdown',
  'mdx',
  'onExtraFieldData',
  'onMissingOrIncompatibleData',
  'onSuccess'
])

const OTHER: Record<string, Pick<Note, 'kind' | 'message' | 'hint'>> = {
  disableImportAliasWarning: {
    kind: 'review',
    message: 'dropped — there is no import alias warning to disable'
  },
  onUnknownDocuments: {
    kind: 'review',
    message: 'dropped — contentmap only reads the files a collection includes'
  },
  contentDirInclude: {
    kind: 'manual',
    message: 'has no direct equivalent',
    hint: 'Narrow each collection’s `include` instead.'
  },
  date: {
    kind: 'manual',
    message: 'date options such as `timezone` have no equivalent',
    hint: 'Dates go through `z.coerce.date()`; adjust them in transform if the timezone mattered.'
  }
}

/** Every other makeSource option, so nothing in it goes unmentioned. */
function otherOptions(
  file: ts.SourceFile,
  options: ts.ObjectLiteralExpression | undefined,
  notes: Note[]
): void {
  if (!options) return
  for (const entry of entriesOf(file, options, () => undefined)) {
    if (HANDLED.has(entry.name)) continue
    notes.push({
      subject: entry.name,
      ...(OTHER[entry.name] ?? {
        kind: 'review',
        message: 'not carried over',
        hint: 'contentmap has no option by this name.'
      })
    })
  }
}

function contentDirExclude(
  file: ts.SourceFile,
  options: ts.ObjectLiteralExpression | undefined,
  notes: Note[]
): string[] | undefined {
  const expr = options && prop(options, 'contentDirExclude')
  if (!expr) return undefined
  const paths = resolveArray(file, expr)?.elements.map(element => stringOf(element))
  if (!paths || paths.some(path => path === undefined)) {
    notes.push({
      kind: 'manual',
      subject: 'contentDirExclude',
      message: `\`${short(expr)}\` is not a list of literal paths`,
      hint: 'Add the exclusions to each collection’s `exclude` by hand.'
    })
    return undefined
  }
  notes.push({
    kind: 'review',
    subject: 'contentDirExclude',
    message: 'became `exclude` on every collection'
  })
  return (paths as string[]).flatMap(path => {
    const trimmed = path.replace(/\/+$/, '')
    // contentlayer accepted a file or a directory, so the glob covers both.
    return [trimmed, `${trimmed}/**`]
  })
}

/** Local names for the transform, never shadowing a top-level name it may read. */
function localsFor(file: ts.SourceFile): Locals {
  const taken = new Set(topLevelBindings(file).keys())
  const pick = (wanted: string): string => {
    let name = wanted
    for (let n = 2; taken.has(name); n++) name = `${wanted}${n}`
    taken.add(name)
    return name
  }
  return { doc: pick('doc'), ctx: pick('ctx'), body: pick('body'), legacy: pick('legacy') }
}

function unfollowed(
  key: string,
  subject: string,
  node: ts.Node,
  where: 'schema' | 'transform'
): Note {
  return {
    kind: 'manual',
    collection: key,
    subject,
    message: `\`${short(node)}\` could not be followed, so what it adds was not carried over`,
    hint:
      where === 'schema'
        ? 'Add those fields to the schema by hand.'
        : 'Add those fields to transform by hand.'
  }
}

function literal(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
