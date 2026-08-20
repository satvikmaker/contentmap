import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SourceTool } from './types.ts'

export interface Detected {
  tool: SourceTool
  /** Absolute path of the config that was found. */
  path: string
  source: string
}

/**
 * Config filenames each tool looks for, most specific first.
 *
 * Extensions are tried in the order each tool documents, so a project with both
 * a `.ts` and a stale `.js` gets the one its tool would actually have loaded.
 */
const CANDIDATES: { tool: SourceTool; files: string[] }[] = [
  {
    tool: 'contentlayer2',
    files: ['contentlayer.config.ts', 'contentlayer.config.js', 'contentlayer.config.mjs']
  },
  {
    tool: 'velite',
    files: ['velite.config.ts', 'velite.config.js', 'velite.config.mjs']
  },
  {
    tool: 'content-collections',
    files: ['content-collections.ts', 'content-collections.js', 'content-collections.mjs']
  }
]

/** Import specifier that identifies each tool, for confirming a guess. */
const SPECIFIERS: Record<SourceTool, RegExp> = {
  contentlayer2: /['"]contentlayer2?(\/[^'"]*)?['"]/,
  velite: /['"]velite['"]/,
  'content-collections': /['"]@content-collections\/core['"]/
}

/**
 * Find a config to migrate.
 *
 * Filename alone is not enough — projects rename things, and a file called
 * `content-collections.ts` in a velite project is not unheard of. The import
 * is what the tool itself keys on, so it decides.
 */
export async function detect(root: string): Promise<Detected | undefined> {
  const found: Detected[] = []
  for (const { tool, files } of CANDIDATES) {
    for (const file of files) {
      const path = join(root, file)
      const source = await readFile(path, 'utf8').catch(() => undefined)
      if (source === undefined) continue
      found.push({ tool, path, source })
      break
    }
  }
  if (found.length === 0) return undefined

  // Prefer one whose imports agree with its filename.
  const confirmed = found.find(f => SPECIFIERS[f.tool].test(f.source))
  if (confirmed) return confirmed

  // Filename matched but imports did not: re-read the imports and believe them.
  for (const candidate of found) {
    for (const [tool, specifier] of Object.entries(SPECIFIERS) as [SourceTool, RegExp][]) {
      if (specifier.test(candidate.source)) return { ...candidate, tool }
    }
  }
  return found[0]
}
