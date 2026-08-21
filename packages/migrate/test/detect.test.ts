import { describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { detect } from '../src/detect.ts'
import { run } from '../src/cli.ts'
import { fixtureTest } from '../../contentmap/test/helpers.ts'

const VELITE = `import { defineConfig, defineCollection, s } from 'velite'
const posts = defineCollection({ name: 'Post', pattern: '**/*.md', schema: s.object({ title: s.string() }) })
export default defineConfig({ root: 'content', collections: { posts } })
`
const CONTENTLAYER = `import { defineDocumentType, makeSource } from 'contentlayer2/source-files'
const Post = defineDocumentType(() => ({ name: 'Post', filePathPattern: '*.md', contentType: 'data', fields: {} }))
export default makeSource({ contentDirPath: 'content', documentTypes: [Post] })
`
const CONTENT_COLLECTIONS = `import { defineCollection, defineConfig } from '@content-collections/core'
const posts = defineCollection({ name: 'posts', directory: 'c', include: '*.md', schema: z.object({}) })
export default defineConfig({ collections: [posts] })
`

describe('detect', () => {
  fixtureTest('finds each tool by its config filename', async ({ fixture }) => {
    for (const [file, source, tool] of [
      ['velite.config.ts', VELITE, 'velite'],
      ['contentlayer.config.ts', CONTENTLAYER, 'contentlayer2'],
      ['content-collections.ts', CONTENT_COLLECTIONS, 'content-collections']
    ] as const) {
      const dir = join(fixture.dir, tool)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, file), source)

      const found = await detect(dir)
      expect(found?.tool, file).toBe(tool)
      expect(found?.path).toContain(file)
    }
  })

  fixtureTest('believes the imports over the filename', async ({ fixture }) => {
    // Projects rename things. The import is what the tool itself keys on, so a
    // velite config living in content-collections.ts is still a velite config —
    // and translating it as the wrong tool would silently produce nonsense.
    await fixture.write('content-collections.ts', VELITE)

    const found = await detect(fixture.dir)

    expect(found?.tool).toBe('velite')
  })

  fixtureTest('returns undefined when there is nothing to migrate', async ({ fixture }) => {
    await fixture.write('package.json', '{}')
    expect(await detect(fixture.dir)).toBeUndefined()
  })

  fixtureTest('prefers .ts over a stale .js of the same name', async ({ fixture }) => {
    await fixture.write('velite.config.ts', VELITE)
    await fixture.write('velite.config.js', '// an old build artifact')

    const found = await detect(fixture.dir)

    expect(found?.path.endsWith('.ts')).toBe(true)
  })

  fixtureTest('picks the confirmed one when two configs are present', async ({ fixture }) => {
    // A project part-way through a migration can have both on disk.
    await fixture.write('contentlayer.config.ts', '// leftover, imports nothing')
    await fixture.write('velite.config.ts', VELITE)

    const found = await detect(fixture.dir)

    expect(found?.tool).toBe('velite')
  })

  fixtureTest('reads .mjs configs', async ({ fixture }) => {
    await fixture.write('velite.config.mjs', VELITE)
    expect((await detect(fixture.dir))?.tool).toBe('velite')
  })
})

/** Capture CLI output, so assertions read what a user would see. */
async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const so = process.stdout.write.bind(process.stdout)
  const se = process.stderr.write.bind(process.stderr)
  process.stdout.write = (c: string | Uint8Array): boolean => (out.push(String(c)), true)
  process.stderr.write = (c: string | Uint8Array): boolean => (err.push(String(c)), true)
  try {
    return { code: await run(args), out: out.join(''), err: err.join('') }
  } finally {
    process.stdout.write = so
    process.stderr.write = se
  }
}

describe('migrate cli', () => {
  fixtureTest('writes a config and a report', async ({ fixture }) => {
    await fixture.write('velite.config.ts', VELITE)

    const { code, out } = await cli(['--root', fixture.dir])

    expect(code).toBe(0)
    expect(out).toContain('velite')
    const config = await fixture.read('contentmap.config.ts')
    expect(config).toContain('defineCollection')
    expect(await fixture.read('CONTENTMAP-MIGRATION.md')).toContain('Migrating from velite')
  })

  fixtureTest('never modifies the config it read', async ({ fixture }) => {
    await fixture.write('velite.config.ts', VELITE)

    await cli(['--root', fixture.dir])

    expect(await fixture.read('velite.config.ts')).toBe(VELITE)
  })

  fixtureTest('refuses to overwrite an existing config without --force', async ({ fixture }) => {
    await fixture.write('velite.config.ts', VELITE)
    await fixture.write('contentmap.config.ts', '// mine, hand-edited')

    const { code, err } = await cli(['--root', fixture.dir])

    expect(code).toBe(1)
    expect(err).toContain('--force')
    expect(await fixture.read('contentmap.config.ts')).toBe('// mine, hand-edited')
  })

  fixtureTest('replaces it when --force is given', async ({ fixture }) => {
    await fixture.write('velite.config.ts', VELITE)
    await fixture.write('contentmap.config.ts', '// mine')

    const { code } = await cli(['--root', fixture.dir, '--force'])

    expect(code).toBe(0)
    expect(await fixture.read('contentmap.config.ts')).toContain('defineCollection')
  })

  fixtureTest('--dry-run prints the result and writes nothing', async ({ fixture }) => {
    await fixture.write('velite.config.ts', VELITE)

    const { code, out } = await cli(['--root', fixture.dir, '--dry-run'])

    expect(code).toBe(0)
    expect(out).toContain('defineCollection')
    await expect(fixture.read('contentmap.config.ts')).rejects.toThrow()
  })

  fixtureTest('says so when there is nothing to migrate', async ({ fixture }) => {
    await fixture.write('package.json', '{}')

    const { code, err } = await cli(['--root', fixture.dir])

    expect(code).toBe(1)
    expect(err).toContain('No contentlayer, velite or content-collections config')
  })

  fixtureTest('honours -o and --report', async ({ fixture }) => {
    await fixture.write('velite.config.ts', VELITE)

    const { code } = await cli([
      '--root',
      fixture.dir,
      '-o',
      'custom.config.ts',
      '--report',
      'NOTES.md'
    ])

    expect(code).toBe(0)
    expect(await fixture.read('custom.config.ts')).toContain('defineCollection')
    expect(await fixture.read('NOTES.md')).toContain('Migrating')
  })

  fixtureTest('rejects an unknown flag rather than ignoring it', async ({ fixture }) => {
    const { code, err } = await cli(['--root', fixture.dir, '--nonsense'])
    expect(code).toBe(1)
    expect(err).toContain('Usage')
  })

  it('prints help on request', async () => {
    const { code, out } = await cli(['--help'])
    expect(code).toBe(0)
    expect(out).toContain('contentmap-migrate')
  })
})
