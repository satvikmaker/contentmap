import { emitConfig, renderNotes } from './emit.ts'
import { detect } from './detect.ts'
import { migrateContentCollections } from './sources/content-collections.ts'
import { migrateContentlayer } from './sources/contentlayer.ts'
import { migrateVelite } from './sources/velite.ts'
import { parse } from './ts.ts'
import type { MigrationResult, SourceTool } from './types.ts'

export type { MigrationResult, Note, NoteKind, SourceTool } from './types.ts'
export { detect } from './detect.ts'
export { renderNotes } from './emit.ts'

const TRANSLATORS = {
  contentlayer2: migrateContentlayer,
  velite: migrateVelite,
  'content-collections': migrateContentCollections
} as const

/** Packages a migrated config needs, beyond contentmap itself. */
const ALWAYS = ['contentmap', 'zod']

/**
 * Translate one config.
 *
 * Source-to-source rather than evaluate-and-serialise. Running the old config
 * would need the old tool to still install, which for contentlayer is the whole
 * problem, and a transform is a closure that cannot be turned back into text
 * anyway.
 */
export function migrate(source: string, tool: SourceTool, fileName?: string): MigrationResult {
  const file = parse(source, fileName)
  const plan = TRANSLATORS[tool](file)
  const install = [...ALWAYS]
  if (plan.notes.some(n => n.hint?.includes('@contentmap/image'))) install.push('@contentmap/image')
  if (plan.notes.some(n => n.hint?.includes('@contentmap/markdown'))) {
    install.push('@contentmap/markdown')
  }

  return {
    tool,
    config: emitConfig(plan),
    collections: plan.collections.map(c => c.key),
    notes: plan.notes,
    install
  }
}

/** Detect and translate in one step. Returns undefined when nothing is found. */
export async function migrateProject(root: string): Promise<MigrationResult | undefined> {
  const found = await detect(root)
  if (!found) return undefined
  return migrate(found.source, found.tool, found.path)
}

export { renderNotes as renderReport }
