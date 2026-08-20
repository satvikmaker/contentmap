import { callsTo, objectOf, prop, resolveObject, stringOf, text, ts } from '../ts.ts'
import type { CollectionPlan, EmitPlan } from '../emit.ts'
import type { Note } from '../types.ts'

/**
 * content-collections is the closest of the three.
 *
 * Both tools validate with a Standard Schema and both spell a collection
 * `{ name, directory, include, schema, transform }`, so most of this is
 * lifting text across rather than translating it. The differences that matter:
 * collections are an array there and an object here, and the transform context
 * exposes a different set of helpers.
 */
export function migrateContentCollections(file: ts.SourceFile): EmitPlan {
  const notes: Note[] = []
  const collections: CollectionPlan[] = []

  const configCall = callsTo(file, 'defineConfig')[0]
  const configObject = configCall ? objectOf(configCall.arguments[0]) : undefined

  // `content` is current; `collections` is deprecated but still everywhere.
  const listExpr =
    (configObject && prop(configObject, 'content')) ??
    (configObject && prop(configObject, 'collections'))

  const elements: ts.Expression[] = []
  const array = listExpr && ts.isArrayLiteralExpression(listExpr) ? listExpr : undefined
  if (array) {
    for (const el of array.elements) elements.push(el)
  } else {
    // No config call found, or it referenced something we cannot follow: fall
    // back to every defineCollection in the file, which is what the user meant.
    for (const call of [
      ...callsTo(file, 'defineCollection'),
      ...callsTo(file, 'defineSingleton')
    ]) {
      elements.push(call)
    }
  }

  for (const element of elements) {
    const object = resolveObject(file, element)
    if (!object) {
      notes.push({
        kind: 'manual',
        subject: text(element),
        message: 'could not be followed to a collection definition',
        hint: 'Add it to the generated config by hand.'
      })
      continue
    }

    const name = stringOf(prop(object, 'name')) ?? 'collection'
    const key = ts.isIdentifier(element) ? element.text : name
    const single = isSingleton(file, element)

    const plan: CollectionPlan = { key, name, fields: [] }
    const directory = stringOf(prop(object, 'directory'))
    if (directory !== undefined) plan.directory = directory
    const include = literalOrList(prop(object, 'include'))
    if (include !== undefined) plan.include = include
    const exclude = literalOrList(prop(object, 'exclude'))
    if (exclude !== undefined) plan.exclude = exclude
    const parser = stringOf(prop(object, 'parser'))
    if (parser !== undefined) plan.parser = parser
    const typeName = stringOf(prop(object, 'typeName'))
    if (typeName !== undefined) plan.typeName = typeName
    if (single) plan.single = true

    const schema = prop(object, 'schema')
    if (schema) plan.schema = text(schema)

    const transform = prop(object, 'transform')
    if (transform) {
      const original = text(transform)
      // content-collections hands `_meta` to the transform on the document.
      // contentmap validates first and passes only the schema's own output, so
      // `_meta` lives on the context. Same field names, different owner — and
      // left alone it reads as undefined at runtime rather than failing loudly.
      const rewritten = withContext(transform, original.replace(/\b(\w+)\._meta\b/g, 'ctx.meta'))
      plan.transform = rewritten
      if (rewritten !== original) {
        notes.push({
          kind: 'review',
          collection: key,
          subject: 'transform',
          message: '`_meta` was moved from the document onto the context',
          hint: 'The field names are identical; only the owner changed.'
        })
      }
      notes.push({
        kind: 'manual',
        collection: key,
        subject: 'transform',
        message: 'carried over, but the context object is not the same',
        hint:
          'content-collections passes `{ documents, collection, cache }`; contentmap passes ' +
          '`{ meta, body, markdown, image, documents, addWatchFile, emitFile }`. `cache()` has ' +
          'no equivalent — contentmap caches every transform by content digest already.'
      })
    }

    if (prop(object, 'onSuccess')) {
      notes.push({
        kind: 'unsupported',
        collection: key,
        subject: 'onSuccess',
        message: 'contentmap has no per-collection completion hook',
        hint: 'Run the work after `contentmap build` instead, or from your own script.'
      })
    }

    collections.push(plan)
  }

  if (configObject && prop(configObject, 'cache')) {
    notes.push({
      kind: 'review',
      subject: 'cache',
      message: 'dropped — contentmap always caches transforms on disk, keyed by content digest',
      hint: 'Nothing to configure. `--cache-dir` moves where it lives.'
    })
  }
  if (configObject && prop(configObject, 'hooks')) {
    notes.push({
      kind: 'unsupported',
      subject: 'hooks',
      message: 'contentmap has no global build hooks',
      hint: 'Wrap `contentmap build` in your own script.'
    })
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

/**
 * Give the transform a `ctx` parameter if the rewrite started using one.
 *
 * content-collections transforms are commonly written `(doc) => …` because the
 * context is rarely needed. Moving `_meta` onto the context makes it needed, and
 * a rewrite that references a parameter the function does not declare produces
 * "ctx is not defined" on the first build — which a text-comparison test cannot
 * see, and a real build finds immediately.
 */
function withContext(node: ts.Expression, rewritten: string): string {
  if (!rewritten.includes('ctx.')) return rewritten
  if (!ts.isArrowFunction(node)) return rewritten
  if (node.parameters.length >= 2) return rewritten

  const first = node.parameters[0]
  const name = first && ts.isIdentifier(first.name) ? first.name.text : 'doc'
  // Everything before the arrow is `async?` plus the parameter list, so
  // replacing that span rewrites both forms — `doc =>` and `(doc) =>` — without
  // having to work out whether parentheses were there.
  const head = rewritten.slice(0, node.equalsGreaterThanToken.getStart() - node.getStart())
  const isAsync = /\basync\b/.test(head)
  return `${isAsync ? 'async ' : ''}(${name}, ctx) ${rewritten.slice(head.length)}`
}

/** `defineSingleton(...)` means one document, which contentmap spells `single`. */
function isSingleton(file: ts.SourceFile, element: ts.Expression): boolean {
  const call = ts.isCallExpression(element)
    ? element
    : ts.isIdentifier(element)
      ? initializerCall(file, element.text)
      : undefined
  const target = call?.expression
  return target !== undefined && ts.isIdentifier(target) && target.text === 'defineSingleton'
}

function initializerCall(file: ts.SourceFile, name: string): ts.CallExpression | undefined {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== name) continue
      if (decl.initializer && ts.isCallExpression(decl.initializer)) return decl.initializer
    }
  }
  return undefined
}

function literalOrList(node: ts.Expression | undefined): string | string[] | undefined {
  const single = stringOf(node)
  if (single !== undefined) return single
  if (node && ts.isArrayLiteralExpression(node)) {
    const items = node.elements.map(e => stringOf(e)).filter((s): s is string => s !== undefined)
    if (items.length === node.elements.length) return items
  }
  return undefined
}
