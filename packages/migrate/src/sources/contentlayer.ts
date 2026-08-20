import { booleanOf, callsTo, objectOf, prop, resolveObject, stringOf, text, ts } from '../ts.ts'
import type { CollectionPlan, EmitPlan } from '../emit.ts'
import type { Note } from '../types.ts'

/**
 * contentlayer is the furthest from contentmap, and the one people most need
 * to leave — it has been unmaintained since its sponsor withdrew.
 *
 * Its fields are a bespoke DSL rather than a schema library, so every field has
 * to be rebuilt as zod. That is the part worth automating: it is mechanical,
 * tedious, and easy to get subtly wrong by hand.
 */
const SCALARS: Record<string, string> = {
  string: 'z.string()',
  number: 'z.number()',
  boolean: 'z.boolean()',
  // contentlayer parses dates itself and hands back an ISO string; coerce keeps
  // the frontmatter tolerant while giving you a real Date.
  date: 'z.coerce.date()',
  markdown: 'z.string()',
  mdx: 'z.string()',
  json: 'z.unknown()'
}

export function migrateContentlayer(file: ts.SourceFile): EmitPlan {
  const notes: Note[] = []
  const collections: CollectionPlan[] = []

  const source = callsTo(file, 'makeSource')[0]
  const sourceObject = source ? objectOf(source.arguments[0]) : undefined
  const contentDir = stringOf(sourceObject && prop(sourceObject, 'contentDirPath')) ?? 'content'

  const types: ts.Expression[] = []
  const declared = sourceObject && prop(sourceObject, 'documentTypes')
  if (declared && ts.isArrayLiteralExpression(declared)) {
    for (const el of declared.elements) types.push(el)
  } else {
    for (const call of callsTo(file, 'defineDocumentType')) types.push(call)
  }

  for (const entry of types) {
    const object = resolveObject(file, entry)
    if (!object) {
      notes.push({
        kind: 'manual',
        subject: text(entry),
        message: 'could not be followed to a document type'
      })
      continue
    }

    const typeName = stringOf(prop(object, 'name')) ?? 'Document'
    const key = pluralise(typeName)
    const plan: CollectionPlan = { key, name: key, typeName, directory: contentDir, fields: [] }

    const pattern = stringOf(prop(object, 'filePathPattern'))
    if (pattern !== undefined) plan.include = pattern
    if (booleanOf(prop(object, 'isSingleton')) === true) plan.single = true

    const contentType = stringOf(prop(object, 'contentType')) ?? 'markdown'
    if (contentType === 'mdx') {
      notes.push({
        kind: 'unsupported',
        collection: key,
        subject: "contentType: 'mdx'",
        message: 'contentmap does not compile MDX',
        hint:
          'The body is still available as `content`. Compile it in your app, or keep this ' +
          'collection on its current tool until MDX lands.'
      })
    }
    if (contentType !== 'data') {
      // contentlayer injects `body` implicitly; contentmap injects `content`.
      plan.fields.push({ name: 'content', expression: 'z.string()' })
      notes.push({
        kind: 'review',
        collection: key,
        subject: 'body',
        message: 'contentlayer exposed the body as `body.raw` / `body.html`',
        hint:
          'contentmap puts the raw body in `content`. For HTML, render it in a transform with ' +
          '`await ctx.markdown()` and register a renderer.'
      })
    }

    const fields = objectOf(prop(object, 'fields'))
    if (fields) translateFields(fields, key, plan, notes)

    const computed = objectOf(prop(object, 'computedFields'))
    if (computed) plan.transform = buildTransform(computed, key, notes)

    collections.push(plan)
  }

  for (const [key, message] of [
    ['mdx', 'MDX options are not carried over — contentmap does not compile MDX'],
    ['markdown', 'markdown options move to the renderer you register'],
    ['onSuccess', 'no build completion hook'],
    ['onExtraFieldData', 'contentmap reports unknown fields via onUnknownField instead'],
    ['onMissingOrIncompatibleData', 'contentmap reports these as diagnostics instead'],
    ['disableImportAliasWarning', 'no equivalent, and no warning to disable']
  ] as const) {
    if (sourceObject && prop(sourceObject, key)) {
      notes.push({ kind: 'review', subject: key, message, hint: 'Not carried over.' })
    }
  }

  return {
    imports: [
      "import { defineCollection, defineConfig } from 'contentmap'",
      "import { z } from 'zod'"
    ],
    collections,
    notes
  }
}

function translateFields(
  fields: ts.ObjectLiteralExpression,
  key: string,
  plan: CollectionPlan,
  notes: Note[]
): void {
  for (const member of fields.properties) {
    if (!ts.isPropertyAssignment(member)) continue
    const name =
      ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : undefined
    if (!name) continue

    const def = objectOf(member.initializer)
    if (!def) {
      notes.push({
        kind: 'manual',
        collection: key,
        subject: name,
        message: 'field definition was not a plain object',
        hint: `Original: ${text(member.initializer)}`
      })
      continue
    }

    const type = stringOf(prop(def, 'type')) ?? 'string'
    const required = booleanOf(prop(def, 'required')) ?? false
    const defaultValue = prop(def, 'default')

    let expression = SCALARS[type]

    if (type === 'enum') {
      const options = prop(def, 'options')
      if (options && ts.isArrayLiteralExpression(options)) {
        expression = `z.enum([${options.elements.map(e => text(e)).join(', ')}])`
      } else {
        expression = 'z.string()'
        notes.push({
          kind: 'review',
          collection: key,
          subject: name,
          message: 'enum options were not a literal array, so it became z.string()',
          hint: 'Narrow it by hand if the values are known.'
        })
      }
    } else if (type === 'list') {
      const of = objectOf(prop(def, 'of'))
      const inner = of
        ? (SCALARS[stringOf(prop(of, 'type')) ?? 'string'] ?? 'z.unknown()')
        : 'z.unknown()'
      expression = `z.array(${inner})`
      if (!of) {
        notes.push({
          kind: 'review',
          collection: key,
          subject: name,
          message: 'list element type was not a plain object, so it became z.array(z.unknown())',
          hint: 'Give the array a real element type.'
        })
      }
    } else if (type === 'nested') {
      expression = 'z.unknown()'
      notes.push({
        kind: 'manual',
        collection: key,
        subject: name,
        message: 'nested document types have no direct equivalent',
        hint: 'Inline the shape as a `z.object({ … })`, or model it as its own collection.'
      })
    } else if (type === 'reference') {
      expression = 'z.string()'
      notes.push({
        kind: 'review',
        collection: key,
        subject: name,
        message: 'became z.string() holding the referenced id',
        hint:
          'Resolve it in a transform with `ctx.documents("<collection>")`, which is how ' +
          'contentmap does cross-collection references.'
      })
    } else if (type === 'image') {
      expression = 'z.string()'
      notes.push({
        kind: 'manual',
        collection: key,
        subject: name,
        message: 'images are handled in a transform',
        hint: 'Call `ctx.image(doc.' + name + ')` in transform. Needs @contentmap/image.'
      })
    } else if (!expression) {
      expression = 'z.unknown()'
      notes.push({
        kind: 'review',
        collection: key,
        subject: name,
        message: `unrecognised field type "${type}", so it became z.unknown()`
      })
    }

    if (defaultValue) expression = `${expression}.default(${text(defaultValue)})`
    else if (!required) expression = `${expression}.optional()`

    plan.fields.push({ name, expression })
  }
}

/**
 * computedFields become one transform.
 *
 * Each resolver's body is preserved verbatim, because it is arbitrary code and
 * rewriting it would be guessing. What changes is the shape around it: the
 * parameter contentlayer calls `doc` exposes `_raw`, which contentmap spells
 * `ctx.meta`.
 */
function buildTransform(computed: ts.ObjectLiteralExpression, key: string, notes: Note[]): string {
  const lines: string[] = ['(doc, ctx) => ({', '  ...doc,']
  for (const member of computed.properties) {
    if (!ts.isPropertyAssignment(member)) continue
    const name =
      ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : undefined
    if (!name) continue
    const def = objectOf(member.initializer)
    const resolve = def && prop(def, 'resolve')
    if (!resolve) {
      notes.push({
        kind: 'manual',
        collection: key,
        subject: `computedFields.${name}`,
        message: 'had no `resolve` function to carry over'
      })
      continue
    }

    const inlined = inlineResolver(resolve)
    if (inlined) {
      lines.push(`  ${name}: ${inlined.expression},`)
      if (inlined.notes.length > 0) {
        notes.push({
          kind: 'review',
          collection: key,
          subject: `computedFields.${name}`,
          message: `rewritten onto the contentmap context (${inlined.notes.join('; ')})`,
          hint: 'Check it reads the way you intended.'
        })
      } else {
        notes.push({
          kind: 'review',
          collection: key,
          subject: `computedFields.${name}`,
          message: 'moved into transform unchanged'
        })
      }
      continue
    }

    // A block body, a named function, or something else that cannot be reduced
    // to one expression. Preserved verbatim and called, so the code is visible
    // and attributed rather than silently dropped.
    lines.push(`  // TODO(contentmap): from contentlayer computedFields.${name}`)
    lines.push(`  ${name}: (${text(resolve)})(doc, ctx),`)
    notes.push({
      kind: 'manual',
      collection: key,
      subject: `computedFields.${name}`,
      message: 'was not a single expression, so it is carried over as a wrapped call',
      hint:
        'Inline it and delete the wrapper. `_raw.flattenedPath` is `ctx.meta.path`, ' +
        '`_raw.sourceFileName` is `ctx.meta.fileName`, `body.raw` is `ctx.body`.'
    })
  }
  const last = lines.length - 1
  lines[last] = (lines[last] ?? '').replace(/,$/, '')
  lines.push('})')
  return lines.join('\n  ')
}

/**
 * contentlayer's document shape, rewritten onto contentmap's context.
 *
 * These are exact equivalents rather than approximations, which is what makes
 * the substitution safe to do automatically. Without it every migrated config
 * crashes on the first build reading `_raw`, and the alternative — leaving it
 * broken with a comment — makes the tool look like it half worked.
 */
const REWRITES: [RegExp, string, string][] = [
  [/\._raw\.flattenedPath\b/g, 'ctx.meta.path', '_raw.flattenedPath -> ctx.meta.path'],
  [/\._raw\.sourceFileName\b/g, 'ctx.meta.fileName', '_raw.sourceFileName -> ctx.meta.fileName'],
  [/\._raw\.sourceFilePath\b/g, 'ctx.meta.filePath', '_raw.sourceFilePath -> ctx.meta.filePath'],
  [/\._raw\.sourceFileDir\b/g, 'ctx.meta.directory', '_raw.sourceFileDir -> ctx.meta.directory'],
  [/\.body\.raw\b/g, 'ctx.body', 'body.raw -> ctx.body'],
  [/\._id\b/g, 'ctx.meta.id', '_id -> ctx.meta.id']
]

interface Inlined {
  expression: string
  notes: string[]
}

/**
 * Reduce `doc => <expression>` to that expression, rewritten.
 *
 * Only for arrow functions with an expression body: anything with statements
 * needs a human, and pretending otherwise would produce code that looks
 * finished and is not.
 */
function inlineResolver(resolve: ts.Expression): Inlined | undefined {
  if (!ts.isArrowFunction(resolve)) return undefined
  const body = resolve.body
  if (ts.isBlock(body)) return undefined

  const param = resolve.parameters[0]
  const paramName = param && ts.isIdentifier(param.name) ? param.name.text : undefined
  if (!paramName) return undefined

  let expression = text(body)
  const applied: string[] = []
  for (const [pattern, replacement, description] of REWRITES) {
    // Anchored to this resolver's own parameter, so a same-named property on
    // some other object is left alone.
    const scoped = new RegExp(`\\b${paramName}${pattern.source}`, 'g')
    if (scoped.test(expression)) {
      expression = expression.replace(scoped, replacement)
      applied.push(description)
    }
  }

  // `body.html` needs a renderer and an await, which changes the transform's
  // signature. Out of scope for a mechanical rewrite.
  if (new RegExp(`\\b${paramName}\\.body\\.(html|code)\\b`).test(expression)) return undefined

  // Any remaining reference to the parameter is a plain field read, and the
  // transform's own parameter is also called doc.
  if (paramName !== 'doc') {
    expression = expression.replace(new RegExp(`\\b${paramName}\\.`, 'g'), 'doc.')
  }
  return { expression, notes: applied }
}

/**
 * contentlayer names a document type in the singular and exports the plural.
 *
 * Deliberately not a full inflector: the handful of endings below cover what
 * appears in real configs, and a wrong plural is visible in the generated file
 * rather than hidden.
 */
function pluralise(name: string): string {
  const lower = name.charAt(0).toLowerCase() + name.slice(1)
  if (/(s|sh|ch|x|z)$/.test(lower)) return `${lower}es`
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`
  return `${lower}s`
}
