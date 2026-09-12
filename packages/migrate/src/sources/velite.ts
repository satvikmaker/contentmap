import {
  callsTo,
  entriesOf,
  objectOf,
  prop,
  resolveObject,
  short,
  stringOf,
  text,
  ts
} from '../ts.ts'
import { propertyKey, type CollectionPlan, type ConfigProp, type EmitPlan } from '../emit.ts'
import { afterBuildValue, objectLiteral, type HookSource } from '../hook.ts'
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
  /** Package the replacement needs. */
  install?: string
}

const HELPERS: Record<string, Helper> = {
  isodate: {
    schema: 'z.coerce.date()',
    kind: 'review',
    message: 'became z.coerce.date()',
    hint:
      'velite stored an ISO string; this gives you a real Date. To keep the string, use ' +
      '`z.coerce.date().transform(d => d.toISOString())`.'
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
      'Register a renderer: `renderer: markdown()` from @contentmap/markdown.',
    install: '@contentmap/markdown'
  },
  mdx: {
    kind: 'manual',
    message: 'MDX compiles through @contentmap/mdx',
    hint:
      'Install @contentmap/mdx, set `mdx: mdx({ minify: true })` on the config, and add ' +
      '`code: await ctx.mdx()` to transform. velite produced the same function-body string, ' +
      'minified — `minify: true` matches it and needs esbuild, which is an optional peer.',
    install: '@contentmap/mdx'
  },
  image: {
    // The frontmatter value is a path string; only the processing moves.
    // Dropping the field would make it unknown frontmatter and get it reported.
    schema: 'z.string()',
    kind: 'manual',
    message: 'stayed a string; the processing moves to a transform',
    hint:
      'Declare the path as `z.string()` and call `ctx.image(doc.cover)` in transform, which ' +
      'returns src, dimensions and a placeholder. Needs @contentmap/image.',
    install: '@contentmap/image'
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

interface Context {
  notes: Note[]
  carry: ts.Node[]
  install: Set<string>
  /** The local name velite's `s` was imported as. */
  s: string
  toZod(code: string): string
}

export function migrateVelite(file: ts.SourceFile): EmitPlan {
  const notes: Note[] = []
  const collections: CollectionPlan[] = []
  const s = schemaName(file)
  const pattern = new RegExp(`\\b${s.replace(/\$/g, '\\$')}\\.`, 'g')
  const context: Context = {
    notes,
    carry: [],
    install: new Set(),
    s,
    toZod: code => code.replace(pattern, 'z.')
  }

  const configCall = callsTo(file, 'defineConfig')[0]
  const configObject = configCall ? resolveObject(file, configCall.arguments[0]) : undefined
  const root = stringOf(configObject && prop(configObject, 'root')) ?? 'content'

  const collectionsExpr = configObject && prop(configObject, 'collections')
  const collectionsObject = resolveObject(file, collectionsExpr)
  const unfollowed = (node: ts.Node): void => {
    notes.push({
      kind: 'manual',
      subject: 'collections',
      message: `\`${short(node)}\` could not be followed, so the collections it adds were not migrated`,
      hint: 'Add them to the generated config by hand.'
    })
  }
  if (collectionsExpr && !collectionsObject) unfollowed(collectionsExpr)
  const entries = collectionsObject ? entriesOf(file, collectionsObject, unfollowed) : []

  for (const { name: key, value } of entries) {
    const object = resolveObject(file, value)
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

    translateSchema(file, prop(object, 'schema'), key, plan, context)
    collections.push(plan)
  }

  for (const [key, message] of [
    ['markdown', 'markdown options move to the renderer you register'],
    ['mdx', 'MDX options move to `mdx()` from @contentmap/mdx'],
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

  const configProps: ConfigProp[] = []

  // velite prints a schema violation as `info`, keeps the document and exits
  // 0; contentmap fails the build. Migrating a real project, that difference
  // turned a green build red on one description three characters over its own
  // `.max(100)` — worth knowing, but not as a broken build on day one. `warn`
  // is what velite was already doing.
  configProps.push("onValidationError: 'warn'")
  notes.push({
    kind: 'review',
    subject: 'onValidationError',
    message: 'velite treated schema violations as advice; contentmap fails the build',
    hint:
      "Set to 'warn' to keep velite's behaviour — the violation is reported and the document " +
      "is kept. Remove it, or set 'fail', once the content is clean."
  })

  // velite's output block maps onto contentmap's field for field, the
  // `[hash:6]` token included, so it is converted rather than reported. It was
  // not read at all before: `data` moves where documents are written and
  // `assets`/`base`/`name` decide where copied files land and what URL they
  // get, and dropping them silently changed the build without saying so.
  const output = configObject && prop(configObject, 'output')
  const outputObject = resolveObject(file, output)
  if (outputObject) {
    const EQUIVALENT = {
      data: 'dir',
      assets: 'assets',
      base: 'assetsBase',
      name: 'assetsName',
      clean: 'clean'
    } as const
    const mapped: string[] = []
    for (const [from, to] of Object.entries(EQUIVALENT)) {
      const value = prop(outputObject, from)
      if (!value) continue
      // Re-quote strings rather than copying the source text, so the emitted
      // config does not mix quote styles with the lines around it.
      const string = stringOf(value)
      mapped.push(
        `${to}: ${string === undefined ? text(value) : `'${string.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`}`
      )
    }
    if (mapped.length) configProps.push(`output: { ${mapped.join(', ')} }`)
    // A key with no equivalent would otherwise go the way the whole block used
    // to: not read, not reported, and quietly not doing what it says.
    for (const member of outputObject.properties) {
      const named = member.name && ts.isIdentifier(member.name) ? member.name.text : undefined
      if (named !== undefined && named in EQUIVALENT) continue
      notes.push({
        kind: 'unsupported',
        subject: 'output',
        message: `\`${named ?? short(member)}\` has no equivalent on contentmap's output`,
        hint: 'Not carried over. contentmap maps data, assets, base, name and clean.'
      })
    }
  } else if (output) {
    notes.push({
      kind: 'manual',
      subject: 'output',
      message: `\`${short(output)}\` could not be followed, so the output settings were not carried over`,
      hint:
        'velite `data` is contentmap `output.dir`, `base` is `assetsBase`, `name` is ' +
        '`assetsName`; `assets` and `clean` keep their names.'
    })
  }

  // complete runs once the build is done, handed every collection's documents
  // — exactly afterBuild's moment — so it is kept as written and given them.
  const complete = configObject && prop(configObject, 'complete')
  if (complete) {
    context.carry.push(complete)
    const keys = collections.map(c => c.key)
    const source: HookSource = {
      fn: complete,
      comment: "velite's collections, rebuilt from contentmap's documents",
      argument: (names, ctx) =>
        objectLiteral(
          keys.map(key => [propertyKey(key), `${ctx}.documents('${names.get(key) ?? key}')`])
        )
    }
    configProps.push(names => `afterBuild: ${afterBuildValue([source], names)}`)
    notes.push({
      kind: 'review',
      subject: 'complete',
      message: 'became `afterBuild`, called with the collections it expects',
      hint: '`ctx.writeFile` also skips unchanged files and never triggers a rebuild.'
    })
    const fn = (complete as { parameters?: ts.NodeArray<ts.ParameterDeclaration> }).parameters
    if (fn && fn.length > 1) {
      notes.push({
        kind: 'manual',
        subject: 'complete',
        message: "its second argument — velite's resolved config — has no equivalent",
        hint: 'Read what it needs from your own config module instead.'
      })
    }
  }

  // prepare ran before output was written, and could change it or suppress
  // it. Nothing in contentmap runs at that point, so it cannot simply move.
  if (configObject && prop(configObject, 'prepare')) {
    notes.push({
      kind: 'manual',
      subject: 'prepare',
      message: 'ran before output was written and could change it; contentmap has no hook there',
      hint:
        "Move changes to documents into each collection's `transform`. If it only wrote files, " +
        'it belongs in `afterBuild`.'
    })
  }

  return {
    imports: [
      { module: 'contentmap', names: ['defineCollection', 'defineConfig'] },
      { module: 'zod', names: ['z'] }
    ],
    collections,
    configProps,
    notes,
    carry: context.carry,
    install: [...context.install],
    // Carried schema fragments — `const tags = s.array(s.string())` — speak
    // velite's `s` too, and have to come across as zod like everything else.
    vocabulary: { names: new Set([s]), rewrite: context.toZod }
  }
}

/** The name `s` was imported under: `import { s } from 'velite'`, or an alias. */
function schemaName(file: ts.SourceFile): string {
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (statement.moduleSpecifier.text !== 'velite') continue
    const named = statement.importClause?.namedBindings
    if (!named || !ts.isNamedImports(named)) continue
    for (const element of named.elements) {
      if ((element.propertyName ?? element.name).getText() === 's') return element.name.text
    }
  }
  return 's'
}

/**
 * Pull fields out of `s.object({ … })`.
 *
 * Anything that is not a plain object literal — a union, a call chain, a
 * variable — is reported rather than guessed at.
 */
function translateSchema(
  file: ts.SourceFile,
  schema: ts.Expression | undefined,
  key: string,
  plan: CollectionPlan,
  context: Context
): void {
  const { notes } = context
  const object = schema && findObjectArgument(file, schema)
  if (!object) {
    if (schema) {
      notes.push({
        kind: 'manual',
        collection: key,
        subject: 'schema',
        message: 'is not a plain `s.object({ … })`, so it was carried over unchanged',
        hint: 'Replace the `s.` calls with their `z.` equivalents by hand.'
      })
      plan.schema = context.toZod(text(schema))
      context.carry.push(schema)
    }
    return
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
  const entries = entriesOf(file, object, node =>
    notes.push({
      kind: 'manual',
      collection: key,
      subject: 'schema',
      message: `\`${short(node)}\` could not be followed, so the fields it adds were not carried over`,
      hint: 'Add them to the schema by hand.'
    })
  )
  for (const { name, value } of entries) {
    const helper = helperFor(value, context.s)
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
      if (spec.install) context.install.add(spec.install)
      if (spec.schema) plan.fields.push({ name, expression: spec.schema })
      continue
    }
    // Plain zod: `s.string().max(99)` is `z.string().max(99)`.
    plan.fields.push({ name, expression: context.toZod(text(value)) })
    context.carry.push(value)
  }

  // velite's markdown/mdx/raw helpers read the document body. contentmap injects
  // the body into `content`, so the schema has to declare it or the body is
  // simply not there to render.
  if (needsBody && !plan.fields.some(f => f.name === 'content')) {
    plan.fields.unshift({ name: 'content', expression: 'z.string()' })
  }
}

/**
 * The object literal inside `s.object({…}).transform(…)`, or inside a const
 * the schema names — `schema: postSchema` is as common as the inline form.
 */
function findObjectArgument(
  file: ts.SourceFile,
  node: ts.Expression
): ts.ObjectLiteralExpression | undefined {
  let current: ts.Expression | undefined = node
  if (ts.isIdentifier(current)) {
    const init = resolveInitializer(file, current.text)
    if (init) current = init
  }
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

function resolveInitializer(file: ts.SourceFile, name: string): ts.Expression | undefined {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl.initializer
    }
  }
  return undefined
}

/** `s.image()` -> 'image', for the outermost velite helper in a chain. */
function helperFor(node: ts.Expression, s: string): string | undefined {
  let current: ts.Expression | undefined = node
  while (current && ts.isCallExpression(current)) {
    const target: ts.Expression = current.expression
    if (!ts.isPropertyAccessExpression(target)) return undefined
    const name = target.name.text
    const receiver: ts.Expression = target.expression
    if (ts.isIdentifier(receiver) && receiver.text === s && name in HELPERS) return name
    current = receiver
  }
  return undefined
}

function patternList(node: ts.Expression | undefined): string[] | undefined {
  if (!node || !ts.isArrayLiteralExpression(node)) return undefined
  const items = node.elements.map(e => stringOf(e)).filter((s): s is string => s !== undefined)
  return items.length === node.elements.length ? items : undefined
}
