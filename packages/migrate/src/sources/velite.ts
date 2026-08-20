import { callsTo, objectOf, prop, resolveObject, stringOf, text, ts } from '../ts.ts'
import type { CollectionPlan, EmitPlan } from '../emit.ts'
import type { Note } from '../types.ts'

/**
 * velite's `s` is zod plus about a dozen helpers of its own.
 *
 * The plain zod surface passes straight through — `s.string()` is `z.string()`.
 * The helpers are the interesting part: most of them are not validation at all
 * but build-time work that contentmap does in a transform, so they cannot be
 * rewritten as a schema field and are reported instead of being faked.
 */
interface Helper {
  /** What to put in the schema, if anything. */
  schema?: string
  message: string
  hint: string
  kind: Note['kind']
}

const HELPERS: Record<string, Helper> = {
  isodate: {
    schema: 'z.coerce.date()',
    kind: 'review',
    message: 'became z.coerce.date()',
    hint: 'velite stored an ISO string; this gives you a real Date. Format at the point of use.'
  },
  slug: {
    schema: 'z.string().optional()',
    kind: 'review',
    message: 'contentmap derives a slug for you',
    hint: 'Use `ctx.meta.slug` in a transform and drop the field, unless the frontmatter sets it.'
  },
  markdown: {
    kind: 'manual',
    message: 'rendering is a transform in contentmap, not a schema field',
    hint:
      'Add `content: z.string()` and, in transform, `html: await ctx.markdown()`. ' +
      'Register a renderer: `renderers: [markdown()]` from @contentmap/markdown.'
  },
  mdx: {
    kind: 'unsupported',
    message: 'contentmap does not compile MDX',
    hint:
      'Keep the source in a `content` field and compile it in your app, or stay on velite for ' +
      'this collection until MDX lands.'
  },
  image: {
    // The frontmatter value is a path string; only the processing moves.
    // Dropping the field would make it unknown frontmatter and get it reported.
    schema: 'z.string()',
    kind: 'manual',
    message: 'stayed a string; the processing moves to a transform',
    hint:
      'Declare the path as `z.string()` and call `ctx.image(doc.cover)` in transform, which ' +
      'returns src, dimensions and a placeholder. Needs @contentmap/image.'
  },
  file: {
    schema: 'z.string()',
    kind: 'manual',
    message: 'stayed a string; the copying moves to a transform',
    hint: 'Declare it as `z.string()` and copy it with `ctx.emitFile()` in transform.'
  },
  excerpt: {
    kind: 'manual',
    message: 'contentmap computes excerpts in a transform',
    hint: 'Add `excerpt: await ctx.excerpt()` to transform. Takes the same length option.'
  },
  toc: {
    kind: 'manual',
    message: 'contentmap builds the table of contents in a transform',
    hint: 'Add `toc: await ctx.toc()` to transform.'
  },
  metadata: {
    kind: 'manual',
    message: "velite's metadata is reading time, which contentmap exposes on the context",
    hint: 'Add `metadata: await ctx.readingTime()` to transform.'
  },
  raw: {
    schema: 'z.string()',
    kind: 'review',
    message: 'became z.string(), which receives the raw body',
    hint: 'contentmap injects the body into `content` unless your schema names it otherwise.'
  },
  path: {
    schema: 'z.string().optional()',
    kind: 'review',
    message: 'contentmap exposes the path as `ctx.meta.path`',
    hint: 'Set it in a transform rather than validating it.'
  },
  unique: {
    kind: 'unsupported',
    message: 'no cross-document uniqueness check',
    hint: 'Assert it in a transform that reads `ctx.documents(...)`, or in a test.'
  }
}

export function migrateVelite(file: ts.SourceFile): EmitPlan {
  const notes: Note[] = []
  const collections: CollectionPlan[] = []

  const configCall = callsTo(file, 'defineConfig')[0]
  const configObject = configCall ? objectOf(configCall.arguments[0]) : undefined
  const root = stringOf(configObject && prop(configObject, 'root')) ?? 'content'

  const collectionsObject = configObject ? objectOf(prop(configObject, 'collections')) : undefined

  const entries: { key: string; expr: ts.Expression }[] = []
  if (collectionsObject) {
    for (const member of collectionsObject.properties) {
      if (ts.isPropertyAssignment(member) && ts.isIdentifier(member.name)) {
        entries.push({ key: member.name.text, expr: member.initializer })
      } else if (ts.isShorthandPropertyAssignment(member)) {
        entries.push({ key: member.name.text, expr: member.name })
      }
    }
  }

  for (const { key, expr } of entries) {
    const object = resolveObject(file, expr)
    if (!object) {
      notes.push({
        kind: 'manual',
        subject: key,
        message: 'could not be followed to a collection definition'
      })
      continue
    }

    const plan: CollectionPlan = {
      key,
      // velite's `name` is the singular type name, not the collection key.
      name: key,
      // velite globs from `root`; contentmap globs from `directory`.
      directory: root,
      fields: []
    }
    const typeName = stringOf(prop(object, 'name'))
    if (typeName !== undefined) plan.typeName = typeName
    const pattern = prop(object, 'pattern')
    const include = stringOf(pattern) ?? patternList(pattern)
    if (include !== undefined) plan.include = include
    if (prop(object, 'single')?.kind === ts.SyntaxKind.TrueKeyword) plan.single = true

    const schema = prop(object, 'schema')
    translateSchema(schema, key, plan, notes)
    collections.push(plan)
  }

  for (const [key, message] of [
    ['markdown', 'markdown options move to the renderer you register'],
    ['mdx', 'contentmap does not compile MDX'],
    ['prepare', 'no global prepare hook'],
    ['complete', 'no global complete hook'],
    ['loaders', 'contentmap calls these parsers; register them with defineParser']
  ] as const) {
    if (configObject && prop(configObject, key)) {
      notes.push({
        kind: key === 'mdx' ? 'unsupported' : 'review',
        subject: key,
        message,
        hint: 'Not carried over. See the contentmap README for the equivalent.'
      })
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

/**
 * Pull fields out of `s.object({ … })`.
 *
 * Anything that is not a plain object literal — a union, a call chain, a
 * variable — is reported rather than guessed at.
 */
function translateSchema(
  schema: ts.Expression | undefined,
  key: string,
  plan: CollectionPlan,
  notes: Note[]
): void {
  const object = schema && findObjectArgument(schema)
  if (!object) {
    if (schema) {
      notes.push({
        kind: 'manual',
        collection: key,
        subject: 'schema',
        message: 'is not a plain `s.object({ … })`, so it was carried over unchanged',
        hint: 'Replace the `s.` calls with their `z.` equivalents by hand.'
      })
      plan.schema = text(schema).replace(/\bs\./g, 'z.')
    }
    return
  }

  if (schema && ts.isCallExpression(schema) === false && !ts.isPropertyAccessExpression(schema)) {
    // fall through — object came from somewhere sensible
  }
  if (schema && /\.transform\(|\.superRefine\(|\.refine\(/.test(text(schema))) {
    notes.push({
      kind: 'manual',
      collection: key,
      subject: 'schema',
      message: 'had a .transform/.refine chain that was not carried over',
      hint: 'contentmap runs `transform` on the collection instead. Move the logic there.'
    })
  }

  let needsBody = false
  for (const member of object.properties) {
    if (!ts.isPropertyAssignment(member)) continue
    const name =
      ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : undefined
    if (!name) continue

    const helper = helperFor(member.initializer)
    if (helper === 'markdown' || helper === 'mdx' || helper === 'raw') needsBody = true
    if (helper) {
      const spec = HELPERS[helper]!
      notes.push({
        kind: spec.kind,
        collection: key,
        subject: `${name} (s.${helper})`,
        message: spec.message,
        hint: spec.hint
      })
      if (spec.schema) plan.fields.push({ name, expression: spec.schema })
      continue
    }
    // Plain zod: `s.string().max(99)` is `z.string().max(99)`.
    plan.fields.push({ name, expression: text(member.initializer).replace(/\bs\./g, 'z.') })
  }

  // velite's markdown/mdx/raw helpers read the document body. contentmap injects
  // the body into `content`, so the schema has to declare it or the body is
  // simply not there to render.
  if (needsBody && !plan.fields.some(f => f.name === 'content')) {
    plan.fields.unshift({ name: 'content', expression: 'z.string()' })
  }
}

/** The first object-literal argument in a call chain like `s.object({…}).transform(…)`. */
function findObjectArgument(node: ts.Expression): ts.ObjectLiteralExpression | undefined {
  let current: ts.Expression | undefined = node
  while (current && ts.isCallExpression(current)) {
    for (const arg of current.arguments) {
      const object = objectOf(arg)
      if (object) return object
    }
    const target: ts.Expression = current.expression
    current = ts.isPropertyAccessExpression(target) ? target.expression : undefined
  }
  return undefined
}

/** `s.image()` -> 'image', for the outermost velite helper in a chain. */
function helperFor(node: ts.Expression): string | undefined {
  let current: ts.Expression | undefined = node
  while (current && ts.isCallExpression(current)) {
    const target: ts.Expression = current.expression
    if (!ts.isPropertyAccessExpression(target)) return undefined
    const name = target.name.text
    const receiver: ts.Expression = target.expression
    if (ts.isIdentifier(receiver) && receiver.text === 's' && name in HELPERS) return name
    current = receiver
  }
  return undefined
}

function patternList(node: ts.Expression | undefined): string[] | undefined {
  if (!node || !ts.isArrayLiteralExpression(node)) return undefined
  const items = node.elements.map(e => stringOf(e)).filter((s): s is string => s !== undefined)
  return items.length === node.elements.length ? items : undefined
}
