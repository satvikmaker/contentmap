import { describe, expect } from 'vitest'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveConfig } from '../src/config/resolve.ts'
import { fixtureTest } from './helpers.ts'
const SRC = pathToFileURL(resolve(import.meta.dirname, '../src/index.ts')).href

describe('config dependency scanning', () => {
  fixtureTest('captures each import syntax', async ({ fixture }) => {
    await fixture.write(
      'schema.ts',
      "import { z } from 'zod'\nexport const S = z.object({ title: z.string() })\n"
    )
    await fixture.write('side.ts', 'export const x = 1\n')
    await fixture.write('multi.ts', 'export const y = 2\n')
    await fixture.write('dyn.ts', 'export const d = 3\n')
    await fixture.write(
      'contentmap.config.ts',
      `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}
import { S } from './schema.ts'
import './side.ts'
import {
  y
} from './multi.ts'
const later = await import('./dyn.ts')
const posts = defineCollection({ name: 'posts', directory: 'c', include: '*.md', schema: S })
export default defineConfig({ collections: { posts } })
`
    )
    const config = await resolveConfig({ root: fixture.dir })
    const names = config.configDeps.map(d => basename(d))
    expect(names, 'named import').toContain('schema.ts')
    expect(names, 'side-effect import').toContain('side.ts')
    expect(names, 'multi-line import').toContain('multi.ts')
    expect(names, 'dynamic import').toContain('dyn.ts')
  })
})
