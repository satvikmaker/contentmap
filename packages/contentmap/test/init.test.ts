import { describe, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { init } from '../src/cli/init.ts'
import { fixtureTest } from './helpers.ts'

describe('init', () => {
  fixtureTest('scaffolds a project and registers the path alias', async ({ fixture }) => {
    // Editing tsconfig by hand is the step people most often miss, and every
    // bundler here resolves generated output through it.
    await fixture.write(
      'package.json',
      JSON.stringify({ name: 'x', dependencies: { next: '^16' } })
    )
    await fixture.write('tsconfig.json', '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n')

    const result = await init({ root: fixture.dir })

    expect(result.detected).toBe('Next.js')
    expect(result.created).toContain('contentmap.config.ts')
    expect(result.updated).toContain('tsconfig.json')
    expect(result.updated).toContain('.gitignore')

    const tsconfig = await readFile(join(fixture.dir, 'tsconfig.json'), 'utf8')
    expect(tsconfig).toContain('"contentmap/generated": ["./.contentmap"]')
    // Rewritten textually, so a hand-maintained tsconfig keeps its formatting.
    expect(tsconfig).toContain('"strict": true')

    expect(await readFile(join(fixture.dir, '.gitignore'), 'utf8')).toContain('.contentmap')
  })

  fixtureTest('never overwrites without being asked', async ({ fixture }) => {
    // A config file is something people edit; replacing one silently is worse
    // than doing nothing.
    await fixture.write('contentmap.config.ts', '// mine\n')
    const result = await init({ root: fixture.dir })
    expect(result.skipped).toContain('contentmap.config.ts')
    expect(await readFile(join(fixture.dir, 'contentmap.config.ts'), 'utf8')).toBe('// mine\n')

    const forced = await init({ root: fixture.dir, force: true })
    expect(forced.created).toContain('contentmap.config.ts')
    expect(await readFile(join(fixture.dir, 'contentmap.config.ts'), 'utf8')).toContain(
      'defineConfig'
    )
  })

  fixtureTest('is idempotent', async ({ fixture }) => {
    await fixture.write('package.json', '{"name":"x"}')
    await fixture.write('tsconfig.json', '{"compilerOptions":{}}')
    await init({ root: fixture.dir })
    const before = await readFile(join(fixture.dir, 'tsconfig.json'), 'utf8')
    const second = await init({ root: fixture.dir })
    expect(second.updated).not.toContain('tsconfig.json')
    expect(await readFile(join(fixture.dir, 'tsconfig.json'), 'utf8')).toBe(before)
  })

  fixtureTest('the scaffolded project builds', async ({ fixture }) => {
    await fixture.write('package.json', '{"name":"x"}')
    await init({ root: fixture.dir })

    const { createBuilder } = await import('../src/builder.ts')
    // The generated config imports 'contentmap' by name, which a temp fixture
    // cannot resolve; point it at the source instead.
    const config = await readFile(join(fixture.dir, 'contentmap.config.ts'), 'utf8')
    const { pathToFileURL } = await import('node:url')
    const { resolve } = await import('node:path')
    await fixture.write(
      'contentmap.config.ts',
      config.replace(
        "from 'contentmap'",
        `from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../src/index.ts')).href)}`
      )
    )

    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBe(0)
    expect(result.documents).toBe(1)
  })
})
