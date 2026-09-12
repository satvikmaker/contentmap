import {
  callsTo,
  elementsOf,
  prop,
  resolveArray,
  resolveObject,
  short,
  stringOf,
  text,
  ts
} from '../ts.ts'
import type { CollectionPlan, ConfigProp, EmitPlan } from '../emit.ts'
import { afterBuildValue, type HookSource } from '../hook.ts'
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
  const carry: ts.Node[] = []
  const hooks: HookSource[] = []

  const configCall = callsTo(file, 'defineConfig')[0]
  const configObject = configCall ? resolveObject(file, configCall.arguments[0]) : undefined

  // `content` is current; `collections` is deprecated but still everywhere.
  const listExpr =
    (configObject && prop(configObject, 'content')) ??
    (configObject && prop(configObject, 'collections'))

  const elements: ts.Expression[] = []
  const array = resolveArray(file, listExpr)
  if (array) {
    const unfollowed = (node: ts.Node): void => {
      notes.push({
        kind: 'manual',
        subject: 'collections',
        message: `\`${short(node)}\` could not be followed, so the collections it adds were not migrated`,
        hint: 'Add them to the generated config by hand.'
      })
    }
    elements.push(...elementsOf(file, array, unfollowed))
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
    if (schema) {
      plan.schema = text(schema)
      carry.push(schema)
    }

    const transform = prop(object, 'transform')
    if (transform) {
      carry.push(transform)
      const original = text(transform)
      // content-collections hands `_meta` to the transform on the document.
      // contentmap validates first and passes only the schema's own output, so
      // `_meta` lives on the context. Same field names, different owner — and
      // left alone it reads as undefined at runtime rather than failing loudly.
      // Whatever the transform calls its context, `_meta` has to move onto
      // that name — spelling it `ctx` regardless emitted a reference to a
      // parameter the function never declared.
      const uses = /\b\w+\._meta\b/.test(original)
      const context = contextFor(transform)
      const declared = uses ? context.declare(original) : original
      // A method is not a value. `transform(doc) { … }` is as valid a way to
      // write one as `transform: doc => …`, and emitted as written it produced
      // `transform: transform(doc) { … }` — a config that did not parse.
      // Applied after `declare`, whose offsets all sit past the method name.
      const asValue = methodAsFunction(transform, declared)
      const rewritten = uses ? asValue.replace(/\b(\w+)\._meta\b/g, context.expression) : asValue
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
      // A transform written elsewhere and named here is carried over as it
      // was, and nothing rewrites the inside of it. Left unsaid, `_meta` reads
      // as undefined on the first build, from code that looks untouched
      // because it is.
      if (!uses && context.opaque && readsMeta(file, transform)) {
        notes.push({
          kind: 'manual',
          collection: key,
          subject: 'transform',
          message: `\`${short(transform)}\` reads \`_meta\`, and it is declared outside the config`,
          hint:
            'It was carried over unchanged. contentmap puts those fields on the transform context, ' +
            'so `doc._meta.path` becomes `ctx.meta.path` where that function is written.'
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

    // onSuccess ran once the collection was written, handed its documents.
    // afterBuild runs once everything is written, so each one becomes a hook
    // handed the same collection.
    const onSuccess = prop(object, 'onSuccess')
    if (onSuccess) {
      carry.push(onSuccess)
      hooks.push({
        fn: onSuccess,
        comment: `the ${key} documents content-collections passed to onSuccess`,
        argument: (names, ctx) => `${ctx}.documents('${names.get(key) ?? key}')`
      })
      notes.push({
        kind: 'review',
        collection: key,
        subject: 'onSuccess',
        message: "became an `afterBuild` hook, called with this collection's documents",
        hint: 'It now runs once every collection is written, rather than just this one.'
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

  const configProps: ConfigProp[] = []
  if (hooks.length > 0) {
    configProps.push(names => `afterBuild: ${afterBuildValue(hooks, names)}`)
  }

  return {
    imports: [
      { module: 'contentmap', names: ['defineCollection', 'defineConfig'] },
      { module: 'zod', names: ['z'] }
    ],
    collections,
    configProps,
    notes,
    carry
  }
}

/**
 * How `<doc>._meta` should be spelled in this transform, and what its parameter
 * list needs so that spelling resolves.
 *
 * Three shapes, because real configs use all three. A transform that names its
 * context — `(doc, context) => …` — has to keep that name: writing `ctx`
 * regardless produced a config referencing a parameter that was never
 * declared. One that takes no context needs one added. One that destructures
 * it — `(doc, { documents }) => …` — has no name to use at all, so `meta` is
 * pulled out of the pattern alongside whatever was already there.
 *
 * `declare` is applied to the ORIGINAL source, before `_meta` is replaced, so
 * the offsets it splices at are the ones the AST reported.
 */
/**
 * Does the function this expression names read `_meta` where it is declared?
 *
 * Only asked about a transform whose parameter list cannot be read from the
 * config — `transform: build`. Both spellings of a top-level function count,
 * because either one is carried over verbatim.
 */
function readsMeta(file: ts.SourceFile, node: ts.Expression): boolean {
  if (!ts.isIdentifier(node)) return false
  const name = node.text
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return /\b\w+\._meta\b/.test(text(statement))
    }
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return /\b\w+\._meta\b/.test(text(declaration))
      }
    }
  }
  return false
}

interface ContextUse {
  /** What `<doc>._meta` becomes. */
  expression: string
  /** Adjust the parameter list so that expression resolves. */
  declare(source: string): string
  /** True when the parameter list cannot be read — a function named elsewhere. */
  opaque?: boolean
}

/**
 * The function literal this expression is, in any of the three spellings a
 * transform is written in.
 *
 * A method is included because `prop()` hands one back: `transform(doc) { … }`
 * and `transform: doc => …` mean the same thing to content-collections, so
 * they have to mean the same thing here.
 */
function functionLike(
  node: ts.Expression
): ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration | undefined {
  const inner = node as unknown as ts.Node
  if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return inner
  if (ts.isMethodDeclaration(inner)) return inner
  return undefined
}

/**
 * Rewrite a method's head so it can be a property's value.
 *
 * Only the head: everything from the parameter list onwards is the text handed
 * in, which by this point may already have a context parameter added to it.
 */
function methodAsFunction(node: ts.Expression, source: string): string {
  const inner = node as unknown as ts.Node
  if (!ts.isMethodDeclaration(inner)) return source
  const isAsync = inner.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false
  return `${isAsync ? 'async ' : ''}function ${source.slice(inner.name.getEnd() - inner.getStart())}`
}

function contextFor(node: ts.Expression): ContextUse {
  const plain = (expression: string): ContextUse => ({ expression, declare: source => source })
  const fn = functionLike(node)
  if (!fn) {
    return { ...plain('ctx.meta'), opaque: true }
  }

  const second = fn.parameters[1]
  if (second && ts.isIdentifier(second.name)) return plain(`${second.name.text}.meta`)

  if (second && ts.isObjectBindingPattern(second.name)) {
    const pattern = second.name
    // Already destructured, under its own name or a renamed one.
    const bound = pattern.elements.find(
      element => (element.propertyName ?? element.name).getText() === 'meta'
    )
    if (bound && ts.isIdentifier(bound.name)) return plain(bound.name.text)
    if (bound) return { ...plain('ctx.meta'), opaque: true }

    const last = pattern.elements[pattern.elements.length - 1]
    // Before the closing brace when the pattern is empty, after the last
    // binding otherwise — both measured from the start of the function so the
    // offset lands in the same place in the text being spliced.
    const at = (last ? last.getEnd() : pattern.getStart() + 1) - fn.getStart()
    return {
      expression: 'meta',
      // A populated pattern already has its closing space; an empty one has
      // nothing between the braces and needs both.
      declare: source => `${source.slice(0, at)}${last ? ', meta' : ' meta '}${source.slice(at)}`
    }
  }

  if (second) return { ...plain('ctx.meta'), opaque: true }

  // No context at all, which is how most of these are written: the context is
  // rarely needed until `_meta` moves onto it.
  const first = fn.parameters[0]
  const name = first && ts.isIdentifier(first.name) ? first.name.text : 'doc'
  return {
    expression: 'ctx.meta',
    declare: source => {
      if (!ts.isArrowFunction(fn)) {
        // Both parameters are written out, even when the source declared
        // none: a bare `ctx` would land in the first position and be handed
        // the document.
        const open = fn.parameters.pos - fn.getStart()
        const close = (first ? first.getEnd() : fn.parameters.end) - fn.getStart()
        return `${source.slice(0, open)}${name}, ctx${source.slice(close)}`
      }
      // Everything before the arrow is `async?` plus the parameter list, so
      // replacing that span rewrites both forms — `doc =>` and `(doc) =>` —
      // without having to work out whether parentheses were there.
      const head = source.slice(0, fn.equalsGreaterThanToken.getStart() - fn.getStart())
      const isAsync = /\basync\b/.test(head)
      return `${isAsync ? 'async ' : ''}(${name}, ctx) ${source.slice(head.length)}`
    }
  }
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
