import { describe, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBuilder } from '../../contentmap/src/builder.ts'
import { fixtureTest, type Fixture } from '../../contentmap/test/helpers.ts'

const CORE = pathToFileURL(resolve(import.meta.dirname, '../../contentmap/src/index.ts')).href
const SEARCH = pathToFileURL(resolve(import.meta.dirname, '../src/index.ts')).href

/** A phrase that only appears in the body, so finding it means the prose shipped. */
const PROSE = 'the pelican wheeled above the estuary at dusk'

const config = (
  hook: string
): string => `import { defineConfig, defineCollection } from ${JSON.stringify(CORE)}
import { miniSearch, orama, pagefind } from ${JSON.stringify(SEARCH)}
import { z } from 'zod'
const posts = defineCollection({
  directory: 'content', include: '**/*.md',
  schema: z.object({ title: z.string(), content: z.string() }),
  transform: doc => ({ ...doc, excerpt: doc.content.slice(0, 20) })
})
export default defineConfig({ collections: { posts }, afterBuild: ${hook} })
`

async function seed(fixture: Fixture, hook: string): Promise<void> {
  await fixture.write('contentmap.config.ts', config(hook))
  await fixture.write('content/a.md', `---\ntitle: Estuary\n---\n${PROSE}`)
  await fixture.write('content/b.md', '---\ntitle: Mountain\n---\nsnow lay on the high ridge')
}

describe('minisearch', () => {
  fixtureTest('builds an index a client can restore and search', async ({ fixture }) => {
    await seed(
      fixture,
      `miniSearch({ collections: [posts], fields: ['title', 'content'], store: ['title'], out: 'public/search.json' })`
    )
    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([])

    const raw = await readFile(join(fixture.dir, 'public/search.json'), 'utf8')
    const { options, index } = JSON.parse(raw) as { options: object; index: object }

    // The options travel with the index precisely so this cannot drift.
    const { default: MiniSearch } = await import('minisearch')
    const restored = MiniSearch.loadJSON(JSON.stringify(index), options as never)
    const hits = restored.search('pelican') as { id: string; title?: string }[]

    expect(hits.length).toBe(1)
    expect(hits[0]!.id).toBe('posts/a')
    expect(hits[0]!.title).toBe('Estuary')
  })

  fixtureTest('indexes the body without shipping it', async ({ fixture }) => {
    // The whole point. `content` is searchable — the term hits — but the prose
    // itself is never in the payload, because it was indexed and not stored.
    await seed(
      fixture,
      `miniSearch({ collections: [posts], fields: ['title', 'content'], store: ['title'], out: 'public/search.json' })`
    )
    await createBuilder({ root: fixture.dir }).build()
    const raw = await readFile(join(fixture.dir, 'public/search.json'), 'utf8')

    expect(raw).not.toContain(PROSE)
    expect(raw).not.toContain('wheeled above')
    expect(raw).toContain('Estuary')
  })

  fixtureTest('warns when asked to store the corpus', async ({ fixture }) => {
    await seed(
      fixture,
      `miniSearch({ collections: [posts], fields: ['title'], store: ['title', 'content'], out: 'public/search.json' })`
    )
    const logs: string[] = []
    const builder = createBuilder({ root: fixture.dir })
    builder.on(event => {
      if (event.type === 'log' && event.level === 'warn') logs.push(event.message)
    })
    await builder.build()

    expect(logs.join('\n')).toContain('full text of every document')
    // ...and it is a warning, not a refusal: the file is still written.
    const raw = await readFile(join(fixture.dir, 'public/search.json'), 'utf8')
    expect(raw).toContain(PROSE)
  })
})

describe('orama', () => {
  fixtureTest('builds an index a client can restore and search', async ({ fixture }) => {
    await seed(
      fixture,
      `orama({ collections: [posts], fields: ['title', 'content'], store: ['title'], out: 'public/orama.json' })`
    )
    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([])

    const raw = await readFile(join(fixture.dir, 'public/orama.json'), 'utf8')
    const { restore } = await import('@orama/plugin-data-persistence')
    const { search } = await import('@orama/orama')
    const db = await restore('json', raw)
    const found = await search(db, { term: 'pelican' })

    expect(found.hits.length).toBe(1)
    expect((found.hits[0]!.document as { title: string }).title).toBe('Estuary')
  })
})

describe('pagefind', () => {
  fixtureTest('writes a bundle through ctx.writeFile, not around it', async ({ fixture }) => {
    // Pagefind's own writeFiles() would put the bundle on disk itself, which
    // skips the byte-compare, the atomic write, and — the one that bites — the
    // watcher exemption, so a dev build would rebuild on its own output.
    await seed(
      fixture,
      `pagefind({ collections: [posts], fields: ['title', 'content'], store: ['title'], out: 'public/pagefind' })`
    )
    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([])

    const { readdir } = await import('node:fs/promises')
    const written = await readdir(join(fixture.dir, 'public/pagefind'))
    // The entry point a browser loads, plus the chunked index beside it.
    expect(written.some(name => name === 'pagefind.js')).toBe(true)
    expect(written.length).toBeGreaterThan(1)
  })

  fixtureTest('coerces metadata Pagefind would otherwise reject', async ({ fixture }) => {
    // meta is strictly flat strings there, and frontmatter is full of numbers
    // and dates. Unguarded, Pagefind does not skip the record: the service
    // throws `invalid type: integer 3, expected a string` and the hook fails
    // the build — which is what the diagnostics assertion below is catching.
    await fixture.write(
      'contentmap.config.ts',
      `import { defineConfig, defineCollection } from ${JSON.stringify(CORE)}
import { pagefind } from ${JSON.stringify(SEARCH)}
import { z } from 'zod'
const posts = defineCollection({
  directory: 'content', include: '**/*.md',
  schema: z.object({ title: z.string(), date: z.coerce.date(), rank: z.number(), content: z.string() })
})
export default defineConfig({
  collections: { posts },
  afterBuild: pagefind({
    collections: [posts], fields: ['content'], store: ['title', 'date', 'rank'],
    out: 'public/pagefind'
  })
})
`
    )
    await fixture.write(
      'content/a.md',
      `---\ntitle: Estuary\ndate: 2026-01-02\nrank: 3\n---\n${PROSE}`
    )

    const logs: string[] = []
    const builder = createBuilder({ root: fixture.dir })
    builder.on(event => {
      if (event.type === 'log' && event.level === 'warn') logs.push(event.message)
    })
    const result = await builder.build()

    expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([])
    // No record was refused for a non-string value.
    expect(logs.join('\n')).not.toContain('addCustomRecord')
  })
})
