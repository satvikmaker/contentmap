import { describe, expect, vi } from 'vitest'
import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBuilder } from '../src/builder.ts'
import { run } from '../src/cli/run.ts'
import { fixtureTest } from './helpers.ts'

const SRC = pathToFileURL(resolve(import.meta.dirname, '../src/index.ts')).href

/**
 * Two small collections — neither of which names itself, since `name` is
 * optional — and an afterBuild hook whose source is `hook`.
 */
const CONFIG = (
  hook: string,
  transform?: string
): string => `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}
import { z } from 'zod'
const authors = defineCollection({
  directory: 'content/authors', include: '**/*.yaml',
  schema: z.object({ name: z.string() })
})
const posts = defineCollection({
  directory: 'content/posts', include: '**/*.md',
  schema: z.object({ title: z.string(), tags: z.array(z.string()).default([]) })${transform ? `,\n  transform: ${transform}` : ''}
})
export default defineConfig({ collections: { authors, posts }, afterBuild: ${hook} })
`

interface Fixture {
  dir: string
  write: (path: string, content: string) => Promise<string>
}

async function seed(fixture: Fixture, hook: string, transform?: string): Promise<void> {
  await fixture.write('contentmap.config.ts', CONFIG(hook, transform))
  await fixture.write('content/authors/ada.yaml', 'name: Ada\n')
  await fixture.write('content/posts/a.md', '---\ntitle: A\ntags: [x, y]\n---\nbody')
  await fixture.write('content/posts/b.md', '---\ntitle: B\ntags: [x]\n---\nbody')
}

const missing = (path: string) => expect(access(path)).rejects.toThrow()

describe('collection references', () => {
  fixtureTest(
    'finds a collection passed by a definition that never named itself',
    async ({ fixture }) => {
      // `name` has been optional since 0.2, defaulting to the key in
      // `collections`. A definition handed to ctx.documents() was looked up by
      // its own `name` property, which an unnamed definition does not have —
      // so the build failed with "unknown collection" for one that plainly
      // exists.
      await seed(
        fixture,
        '[]',
        'async (doc, ctx) => ({ ...doc, authors: (await ctx.documents(authors)).length })'
      )
      const builder = createBuilder({ root: fixture.dir })
      const result = await builder.build()
      expect(result.diagnostics).toEqual([])
      expect(builder.documentsOf('posts').map(post => post['authors'])).toEqual([1, 1])
    }
  )
})

describe('afterBuild', () => {
  fixtureTest(
    'runs once the build is written, with every collection in hand',
    async ({ fixture }) => {
      await seed(
        fixture,
        `async ctx => {
        // The build's own output is complete before any hook runs.
        const { access } = await import('node:fs/promises')
        await access(ctx.root + '/.contentmap/posts/index.js')
        const counts = {}
        for (const post of ctx.documents(posts)) {
          for (const tag of post.tags) counts[tag] = (counts[tag] ?? 0) + 1
        }
        await ctx.writeFile('app/tag-data.json', JSON.stringify(counts))
        await ctx.writeFile('public/search.json', JSON.stringify(ctx.documents('posts').map(p => p.title)))
        await ctx.writeFile('collections.txt', ctx.collections.join(','))
      }`
      )
      const result = await createBuilder({ root: fixture.dir }).build()
      expect(result.diagnostics).toEqual([])

      const read = (path: string) => readFile(join(fixture.dir, path), 'utf8')
      expect(JSON.parse(await read('app/tag-data.json'))).toEqual({ x: 2, y: 1 })
      expect(JSON.parse(await read('public/search.json'))).toEqual(['A', 'B'])
      expect(await read('collections.txt')).toBe('authors,posts')
    }
  )

  fixtureTest('skips a write whose bytes have not changed', async ({ fixture }) => {
    // Rewriting an identical file bumps its mtime, and a dev server watching
    // it reloads the page for nothing.
    await seed(fixture, `ctx => ctx.writeFile('out.json', String(ctx.documents('posts').length))`)
    await createBuilder({ root: fixture.dir }).build()
    const first = (await stat(join(fixture.dir, 'out.json'))).mtimeMs
    await new Promise(done => setTimeout(done, 50))
    await createBuilder({ root: fixture.dir }).build()
    expect((await stat(join(fixture.dir, 'out.json'))).mtimeMs).toBe(first)
  })

  fixtureTest('refuses to write outside the project', async ({ fixture }) => {
    await seed(fixture, `ctx => ctx.writeFile('../escaped.txt', 'x')`)
    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBe(1)
    expect(result.diagnostics[0]?.code).toBe('CM_AFTER_BUILD')
    expect(result.diagnostics[0]?.message).toContain('inside the project')
    await missing(join(fixture.dir, '../escaped.txt'))
  })

  fixtureTest('fails the build when it throws, and the CLI exits non-zero', async ({ fixture }) => {
    await seed(fixture, `() => { throw new Error('search service is down') }`)
    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBe(1)
    expect(result.diagnostics[0]?.message).toBe('afterBuild failed: search service is down')
    // Everything else was written; only the hook's own work is missing.
    await access(join(fixture.dir, '.contentmap/posts/index.js'))

    // `contentmap build` runs the same build, so it has to exit 1 on it.
    const quiet = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const code = await run(['build', '--config', join(fixture.dir, 'contentmap.config.ts')])
      expect(code).toBe(1)
    } finally {
      quiet.mockRestore()
    }
  })

  fixtureTest('runs every hook, and reports each one that fails', async ({ fixture }) => {
    await seed(
      fixture,
      `[
        () => { throw new Error('one') },
        ctx => ctx.writeFile('ran.txt', 'yes'),
        async () => { throw new Error('three') }
      ]`
    )
    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.diagnostics.map(d => d.message)).toEqual([
      'afterBuild #1 failed: one',
      'afterBuild #3 failed: three'
    ])
    expect(await readFile(join(fixture.dir, 'ran.txt'), 'utf8')).toBe('yes')
  })

  fixtureTest('does not run after a build that failed', async ({ fixture }) => {
    // A search index over whichever documents happened to survive is worse
    // than none: it is wrong, and nothing says so.
    await seed(fixture, `ctx => ctx.writeFile('ran.txt', 'yes')`)
    await fixture.write('content/posts/broken.md', '---\ntags: [x]\n---\nno title')
    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBeGreaterThan(0)
    await missing(join(fixture.dir, 'ran.txt'))
  })

  fixtureTest('does not run under check, which writes nothing', async ({ fixture }) => {
    await seed(fixture, `ctx => ctx.writeFile('ran.txt', 'yes')`)
    const result = await createBuilder({ root: fixture.dir, dryRun: true }).build()
    expect(result.errors).toBe(0)
    await missing(join(fixture.dir, 'ran.txt'))
  })

  fixtureTest('rejects something that is not a hook, before building', async ({ fixture }) => {
    await seed(fixture, `'search.json'`)
    await expect(createBuilder({ root: fixture.dir }).build()).rejects.toThrow(/afterBuild/)
  })

  fixtureTest(
    'runs on every rebuild, and never rebuilds for its own writes',
    async ({ fixture }) => {
      // A hook writing something different every time — a timestamp, a build
      // id — into a directory contentmap watches would otherwise start a build
      // from every build, forever. Its temporary file counts too.
      await seed(
        fixture,
        `async ctx => {
        await ctx.writeFile('content/posts/stamp.txt', String(Math.random()))
        await ctx.writeFile('count.txt', String(ctx.documents('posts').length))
      }`
      )
      const builder = createBuilder({ root: fixture.dir, concurrency: 1 })
      let builds = 0
      builder.on(event => {
        if (event.type === 'build:end') builds++
      })
      try {
        await builder.build()
        expect(await readFile(join(fixture.dir, 'count.txt'), 'utf8')).toBe('2')
        await builder.watch({ debounce: 20 })

        // Rewritten on each attempt: `watch()` returns before every OS watch is
        // live, so the guarantee is that a change rebuilds, not that the first
        // write after it wins the race.
        await vi.waitFor(
          async () => {
            await writeFile(join(fixture.dir, 'content/posts/c.md'), '---\ntitle: C\n---\nbody')
            expect(await readFile(join(fixture.dir, 'count.txt'), 'utf8')).toBe('3')
          },
          { timeout: 30_000, interval: 100 }
        )

        // Let rebuilds from those writes land, then watch for more. Every build
        // wrote a fresh stamp into a watched directory, so a loop shows up here.
        await new Promise(done => setTimeout(done, 300))
        const settled = builds
        await new Promise(done => setTimeout(done, 500))
        expect(builds).toBe(settled)
      } finally {
        await builder.close()
      }
    }
  )
})
