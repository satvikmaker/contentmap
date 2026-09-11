import { dirname, resolve } from 'node:path'
import { carry, topLevelBindings, type Binding } from './carry.ts'
import { detect } from './detect.ts'
import { emitConfig, normalizePlan, renderNotes } from './emit.ts'
import { migrateContentCollections } from './sources/content-collections.ts'
import { migrateContentlayer } from './sources/contentlayer.ts'
import { migrateVelite } from './sources/velite.ts'
import { parse, ts, unwrap } from './ts.ts'
import type { MigrateOptions, MigrationResult, Note, SourceTool } from './types.ts'

export type { MigrateOptions, MigrationResult, Note, NoteKind, SourceTool } from './types.ts'
export { detect } from './detect.ts'
export { renderNotes } from './emit.ts'

const TRANSLATORS = {
  contentlayer2: migrateContentlayer,
  velite: migrateVelite,
  'content-collections': migrateContentCollections
} as const

/**
 * Import sources that belong to each tool. Nothing from these is carried into
 * the new config: the point of migrating is that they can be uninstalled.
 */
const TOOL_MODULES: Record<SourceTool, RegExp> = {
  contentlayer2: /^(?:contentlayer2?|next-contentlayer2?|@contentlayer2?\/[^/]+)(?:\/.*)?$/,
  velite: /^velite(?:\/.*)?$/,
  'content-collections': /^@content-collections\/[^/]+(?:\/.*)?$/
}

/** Each tool's definition functions, whose results the translators rebuild. */
const DEFINITIONS: Record<SourceTool, ReadonlySet<string>> = {
  contentlayer2: new Set(['defineDocumentType', 'defineNestedType', 'makeSource']),
  velite: new Set(['defineCollection', 'defineConfig']),
  'content-collections': new Set(['defineCollection', 'defineConfig', 'defineSingleton'])
}

/** Packages a migrated config always needs. */
const ALWAYS = ['contentmap', 'zod']

/** What to do about a name that carried code needs but the old tool took with it. */
const HINTS: Record<string, string> = {
  ComputedFields: 'A contentlayer type. Delete the annotation; the new config needs none.',
  DocumentTypeDef: 'A contentlayer type. Delete the annotation; the new config needs none.',
  FieldDefs: 'A contentlayer type. Delete the annotation; the new config needs none.',
  compileMDX:
    'Use `await ctx.mdx()` in transform, with `mdx: mdx()` from @contentmap/mdx on the config.',
  compileMarkdown: 'Use `await ctx.markdown()` in transform, with a renderer on the config.'
}

/**
 * Translate one config.
 *
 * Source-to-source rather than evaluate-and-serialise. Running the old config
 * would need the old tool to still install, which for contentlayer is the whole
 * problem, and a transform is a closure that cannot be turned back into text
 * anyway.
 */
export function migrate(
  source: string,
  tool: SourceTool,
  fileName?: string,
  options: MigrateOptions = {}
): MigrationResult {
  const file = parse(source, fileName)
  const plan = TRANSLATORS[tool](file)
  const bindings = topLevelBindings(file)
  const isToolModule = (module: string): boolean => TOOL_MODULES[tool].test(module)
  const from = dirname(resolve(fileName ?? 'config.ts'))

  const carried = carry(file, plan.carry ?? [], {
    isToolModule,
    isTranslated: statement => defines(statement, DEFINITIONS[tool], bindings, isToolModule),
    generated: new Set(plan.collections.map(c => c.key)),
    provided: new Map(plan.imports.flatMap(i => i.names.map(name => [name, i.module] as const))),
    ...(plan.vocabulary
      ? { rewritten: plan.vocabulary.names, rewrite: plan.vocabulary.rewrite }
      : {}),
    from,
    to: options.outFile === undefined ? from : dirname(resolve(options.outFile))
  })
  for (const { name, module } of carried.unresolved) plan.notes.push(unresolved(name, module))
  // Normalising can rename a collection; anything emitted that mentions one
  // by name is written against the name it ends up with.
  const originals = plan.collections.map(c => c.key)
  plan.notes.push(...normalizePlan(plan, carried.names))
  const names = new Map(originals.map((key, i) => [key, plan.collections[i]?.key ?? key]))

  return {
    tool,
    config: emitConfig(plan, carried, names),
    collections: plan.collections.map(c => c.key),
    notes: plan.notes,
    install: [...new Set([...ALWAYS, ...(plan.install ?? [])])]
  }
}

/** Detect and translate in one step. Returns undefined when nothing is found. */
export async function migrateProject(root: string): Promise<MigrationResult | undefined> {
  const found = await detect(root)
  if (!found) return undefined
  return migrate(found.source, found.tool, found.path)
}

/**
 * Whether a statement declares something with one of the tool's definition
 * functions — `const posts = defineCollection({ … })`. The translator rebuilt
 * it, so the original stays behind. A call nothing imports counts too: the
 * definition functions are what a config is made of, whatever the file says.
 */
function defines(
  statement: ts.Statement,
  names: ReadonlySet<string>,
  bindings: ReadonlyMap<string, Binding>,
  isToolModule: (module: string) => boolean
): boolean {
  if (!ts.isVariableStatement(statement)) return false
  return statement.declarationList.declarations.some(decl => {
    const init = unwrap(decl.initializer)
    if (!init || !ts.isCallExpression(init)) return false
    const callee = init.expression
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined
    if (name === undefined || !names.has(name)) return false
    const root = ts.isIdentifier(callee)
      ? callee
      : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        ? callee.expression
        : undefined
    const binding = root ? bindings.get(root.text) : undefined
    return binding === undefined || (binding.kind === 'import' && isToolModule(binding.module))
  })
}

function unresolved(name: string, module: string | undefined): Note {
  if (module === undefined) {
    return {
      kind: 'manual',
      subject: name,
      message:
        'is used by code carried over from your config, but it was a definition this migration rewrote',
      hint: 'Point it at the generated collection, or drop the reference.'
    }
  }
  return {
    kind: 'manual',
    subject: name,
    message: `is used by code carried over from your config, but it comes from \`${module}\`, which this migration replaces`,
    hint: HINTS[name] ?? 'Replace it with the contentmap equivalent, or drop the reference.'
  }
}

export { renderNotes as renderReport }
