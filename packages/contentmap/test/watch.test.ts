import { describe, expect, it, vi } from 'vitest'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBuilder } from '../src/builder.ts'
import { fixtureTest } from './helpers.ts'

const SRC = pathToFileURL(resolve(import.meta.dirname, '../src/index.ts')).href

const CONFIG = `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}
import { z } from 'zod'
const posts = defineCollection({
  name: 'posts', directory: 'content', include: '**/*.md',
  schema: z.object({ title: z.string() })
})
export default defineConfig({ collections: { posts } })
`

/**
 * Watcher events come from the OS, so these tests use real time: never fake
 * timers, never a bare sleep.
 *
 * The window is generous because filesystem-event latency scales with machine
 * load, and this file runs alongside ten others. That is not the same as
 * retrying — each assertion must still become true exactly once, and a genuinely
 * missed rebuild still fails. Measured in isolation, every case settles in well
 * under a second.
 */
const WINDOW = 30_000

const until = async (fn: () => Promise<void> | void, context?: () => string): Promise<void> => {
  try {
    await vi.waitFor(fn, { timeout: WINDOW, interval: 25 })
  } catch (error) {
    // A timeout says only "it never became true", which cannot distinguish a
    // watcher that saw nothing from a rebuild that ran and wrote the wrong
    // thing. Both failed identically in CI on Windows and macOS, with the same
    // message either way.
    if (!context) throw error
    throw new Error(`${(error as Error).message}\n\nwatcher activity:\n${context()}`)
  }
}

/** Records what the builder saw, so a timeout can say which half broke. */
function record(builder: ReturnType<typeof createBuilder>): () => string {
  const seen: string[] = []
  builder.on(event => {
    if (event.type === 'watch:change') seen.push(`  change ${event.path}`)
    if (event.type === 'build:start') seen.push('  build:start')
    if (event.type === 'build:end') {
      seen.push(`  build:end  ${event.result.documents} doc(s), ${event.result.errors} error(s)`)
    }
    // The watcher swallows a failed rebuild by design — the next save is
    // usually the fix — so without this a rebuild that threw looks exactly
    // like one that hung. On Windows that distinction was the whole answer.
    if (event.type === 'log' && event.level !== 'debug') {
      seen.push(`  ${event.level}: ${event.message}`)
    }
  })
  return () => (seen.length === 0 ? '  (nothing — the watcher never fired)' : seen.join('\n'))
}

describe('watch mode', { timeout: 60_000 }, () => {
  fixtureTest('rebuilds when a file changes', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', CONFIG)
    await fixture.write('content/a.md', '---\ntitle: First\n---\nx')

    const builder = createBuilder({ root: fixture.dir })
    await builder.build()
    await builder.watch({ debounce: 20 })
    try {
      await fixture.write('content/a.md', '---\ntitle: Second\n---\nx')
      await until(async () => {
        const doc = await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')
        expect(doc).toContain('Second')
      })
    } finally {
      await builder.close()
    }
  })

  fixtureTest('picks up an added file and drops a deleted one', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', CONFIG)
    await fixture.write('content/a.md', '---\ntitle: A\n---\nx')

    const builder = createBuilder({ root: fixture.dir })
    await builder.build()
    await builder.watch({ debounce: 20 })
    try {
      await fixture.write('content/b.md', '---\ntitle: B\n---\nx')
      await until(async () => {
        const index = await readFile(join(fixture.dir, '.contentmap/posts/index.js'), 'utf8')
        expect(index).toContain('"b"')
      })

      await rm(join(fixture.dir, 'content/a.md'))
      await until(async () => {
        const index = await readFile(join(fixture.dir, '.contentmap/posts/index.js'), 'utf8')
        expect(index).not.toContain('"a"')
      })
    } finally {
      await builder.close()
    }
  })

  fixtureTest('coalesces a burst of writes into very few builds', async ({ fixture }) => {
    // content-collections has no debounce, queue or mutex: ten rapid writes
    // there produced ten concurrent builds all writing the same files.
    await fixture.write('contentmap.config.ts', CONFIG)
    for (let i = 0; i < 20; i++) {
      await fixture.write(`content/p${i}.md`, `---\ntitle: P${i}\n---\nx`)
    }

    const builder = createBuilder({ root: fixture.dir })
    await builder.build()
    const activity = record(builder)

    let builds = 0
    let inflight = 0
    let peak = 0
    builder.on(e => {
      if (e.type === 'build:start') {
        builds++
        peak = Math.max(peak, ++inflight)
      }
      if (e.type === 'build:end') inflight--
    })
    // Subscribing replays the buffered history, so the initial build is already
    // counted. Measure from here.
    const baseline = builds

    await builder.watch({ debounce: 30 })
    try {
      for (let i = 0; i < 20; i++) {
        await writeFile(join(fixture.dir, `content/p${i}.md`), `---\ntitle: Edited ${i}\n---\nx`)
      }
      await until(async () => {
        const doc = await readFile(join(fixture.dir, '.contentmap/posts/p19.js'), 'utf8')
        expect(doc).toContain('Edited 19')
      }, activity)

      expect(peak, 'builds must never overlap').toBe(1)
      const rebuilds = builds - baseline
      expect(rebuilds, `20 writes produced ${rebuilds} rebuilds`).toBeLessThanOrEqual(3)
    } finally {
      await builder.close()
    }
  })

  fixtureTest('never rebuilds in response to its own output', async ({ fixture }) => {
    // Watching the output directory is an infinite loop: build writes, watcher
    // fires, build writes.
    await fixture.write('contentmap.config.ts', CONFIG)
    await fixture.write('content/a.md', '---\ntitle: A\n---\nx')

    const builder = createBuilder({ root: fixture.dir })
    await builder.build()

    let builds = 0
    builder.on(e => {
      if (e.type === 'build:start') builds++
    })
    await builder.watch({ debounce: 20 })
    try {
      await fixture.write('content/a.md', '---\ntitle: B\n---\nx')
      await until(async () => {
        const doc = await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')
        expect(doc).toContain('"B"')
      })
      // A write can produce more than one filesystem event, so an extra
      // rebuild is not itself a fault — the output is byte-identical and the
      // writer skips it. What must never happen is a loop: the build writing
      // into a directory it also watches. Settle, then require two consecutive
      // quiet windows.
      let quiet = 0
      let last = builds
      for (let i = 0; i < 20 && quiet < 2; i++) {
        await new Promise(r => setTimeout(r, 250))
        if (builds === last) quiet++
        else {
          quiet = 0
          last = builds
        }
      }
      expect(quiet, `build count never settled (still ${builds})`).toBe(2)
    } finally {
      await builder.close()
    }
  })

  fixtureTest('keeps the last good output when the config breaks', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', CONFIG)
    await fixture.write('content/a.md', '---\ntitle: A\n---\nx')

    const builder = createBuilder({ root: fixture.dir })
    await builder.build()
    const good = await readFile(join(fixture.dir, '.contentmap/posts/index.js'), 'utf8')

    const warnings: string[] = []
    builder.on(e => {
      if (e.type === 'log' && e.level === 'warn') warnings.push(e.message)
    })

    await builder.watch({ debounce: 20 })
    try {
      // A config saved mid-edit is usually a syntax error the next keystroke fixes.
      await writeFile(join(fixture.dir, 'contentmap.config.ts'), 'export default defineConfig({\n')
      await until(() => expect(warnings.some(w => w.includes('config reload failed'))).toBe(true))
      expect(await readFile(join(fixture.dir, '.contentmap/posts/index.js'), 'utf8')).toBe(good)
    } finally {
      await builder.close()
    }
  })

  fixtureTest('closing releases the watcher', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', CONFIG)
    await fixture.write('content/a.md', '---\ntitle: A\n---\nx')
    const builder = createBuilder({ root: fixture.dir })
    await builder.build()
    const handle = await builder.watch({ debounce: 20 })
    expect(handle.paths.length).toBeGreaterThan(0)

    // Subscribe BEFORE closing: a late subscriber is replayed the buffered
    // history, which would count the initial build.
    let builds = 0
    builder.on(e => {
      if (e.type === 'build:start') builds++
    })
    await builder.close()
    const atClose = builds

    await fixture.write('content/a.md', '---\ntitle: After close\n---\nx')
    await new Promise(r => setTimeout(r, 300))
    // A leaked watcher is the usual cause of a hanging test run.
    expect(builds).toBe(atClose)
  })
})

describe('refreshContent', { timeout: 60_000 }, () => {
  fixtureTest('refetches a remote collection on demand', async ({ fixture }) => {
    const first = JSON.stringify({ items: [{ slug: 'a', title: 'One' }] })
    const second = JSON.stringify({ items: [{ slug: 'a', title: 'Two' }] })
    await fixture.write(
      'contentmap.config.ts',
      `import { defineConfig, defineCollection, http } from ${JSON.stringify(SRC)}
import { z } from 'zod'
let n = 0
const news = defineCollection({
  name: 'news',
  loader: http({
    url: 'https://x.invalid/n',
    select: p => p.items,
    id: r => r.slug,
    // A window this long would normally prevent any refetch.
    revalidate: { seconds: 3600 },
    fetch: async () => { n++; return new Response(n === 1 ? ${JSON.stringify(first)} : ${JSON.stringify(second)}, { status: 200 }) }
  }),
  schema: z.object({ slug: z.string(), title: z.string() })
})
export default defineConfig({ collections: { news } })
`
    )

    const builder = createBuilder({ root: fixture.dir })
    await builder.build()
    expect(await readFile(join(fixture.dir, '.contentmap/news/a.js'), 'utf8')).toContain('One')

    // A plain rebuild stays inside the revalidate window.
    await builder.build()
    expect(await readFile(join(fixture.dir, '.contentmap/news/a.js'), 'utf8')).toContain('One')

    // An explicit refresh ignores it — this is what a CMS webhook calls.
    const refreshed = await builder.refreshContent({ loaders: ['news'] })
    expect(refreshed.errors).toBe(0)
    expect(await readFile(join(fixture.dir, '.contentmap/news/a.js'), 'utf8')).toContain('Two')
  })

  fixtureTest('forwards its payload to the loader', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      `import { defineConfig, defineCollection, defineLoader } from ${JSON.stringify(SRC)}
import { z } from 'zod'
const probe = defineCollection({
  name: 'probe',
  loader: defineLoader({
    name: 'probe',
    load: (ctx) => ({
      records: [{
        id: 'x',
        data: { seen: JSON.stringify(ctx.refreshContext ?? null), forced: String(ctx.forced) },
        digest: JSON.stringify(ctx.refreshContext ?? null) + String(ctx.forced)
      }],
      fromCache: false
    })
  }),
  schema: z.object({ seen: z.string(), forced: z.string() })
})
export default defineConfig({ collections: { probe } })
`
    )
    const builder = createBuilder({ root: fixture.dir })
    await builder.build()
    expect(await readFile(join(fixture.dir, '.contentmap/probe/x.js'), 'utf8')).toContain(
      'forced: "false"'
    )

    await builder.refreshContent({ loaders: ['probe'], context: { entryId: 42 } })
    const doc = await readFile(join(fixture.dir, '.contentmap/probe/x.js'), 'utf8')
    expect(doc).toContain('forced: "true"')
    expect(doc).toContain('entryId')
  })
})

describe('watch mode keeps up with the config', { timeout: 60_000 }, () => {
  fixtureTest('watches a directory a config reload introduced', async ({ fixture }) => {
    // A collection added while the dev server runs brings a directory nobody
    // was watching, so edits in it would never rebuild.
    await fixture.write('contentmap.config.ts', CONFIG)
    await fixture.write('content/a.md', '---\ntitle: A\n---\nx')

    const builder = createBuilder({ root: fixture.dir })
    await builder.build()
    const activity = record(builder)
    const handle = await builder.watch({ debounce: 20 })
    try {
      await fixture.write('notes/n1.md', '---\ntitle: Note\n---\nx')
      await fixture.write(
        'contentmap.config.ts',
        `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}
import { z } from 'zod'
const posts = defineCollection({ name: 'posts', directory: 'content', include: '**/*.md', schema: z.object({ title: z.string() }) })
const notes = defineCollection({ name: 'notes', directory: 'notes', include: '**/*.md', schema: z.object({ title: z.string() }) })
export default defineConfig({ collections: { posts, notes } })
`
      )

      await until(async () => {
        const index = await readFile(join(fixture.dir, '.contentmap/notes/index.js'), 'utf8')
        expect(index).toContain('"n1"')
      })
      // Also asynchronous, and settles slightly later than the file above: the
      // watcher's path set is refreshed by sync() after emit, so the index can
      // be on disk while `paths` is still the pre-reload list. Asserting it
      // synchronously passed on Linux and raced on Windows.
      await until(() => {
        expect(handle.paths.some(p => p.endsWith('notes'))).toBe(true)
      })

      // The new directory must now be live.
      //
      // Rewritten on each attempt rather than once up front. `watcher.add()`
      // returns before the OS watch is established — noticeably so on Windows,
      // where a file created inside that gap is never reported. The guarantee
      // is that edits to the new directory get picked up, not that the first
      // write after a reload wins the race. A directory that never became
      // watched still fails here, which is the regression worth catching.
      let n = 0
      await until(async () => {
        await writeFile(join(fixture.dir, 'notes/n2.md'), `---\ntitle: Note ${n++}\n---\nx`)
        const index = await readFile(join(fixture.dir, '.contentmap/notes/index.js'), 'utf8')
        expect(index).toContain('"n2"')
      }, activity)
    } finally {
      await builder.close()
    }
  })

  fixtureTest('rebuilds when a file named by addWatchFile changes', async ({ fixture }) => {
    // The document itself never changes on disk, so nothing else would notice.
    await fixture.write('data/extra.txt', 'one')
    await fixture.write(
      'contentmap.config.ts',
      `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
const posts = defineCollection({
  name: 'posts', directory: 'content', include: '**/*.md',
  schema: z.object({ title: z.string() }),
  transform: (doc, ctx) => {
    const path = join(process.cwd(), 'data/extra.txt')
    ctx.addWatchFile(path)
    return { title: doc.title, extra: readFileSync(path, 'utf8').trim() }
  }
})
export default defineConfig({ collections: { posts } })
`
    )
    await fixture.write('content/a.md', '---\ntitle: A\n---\nx')

    const builder = createBuilder({ root: fixture.dir, concurrency: 1 })
    const activity = record(builder)
    const cwd = process.cwd()
    process.chdir(fixture.dir)
    try {
      await builder.build()
      expect(await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')).toContain('"one"')

      const handle = await builder.watch({ debounce: 20 })
      expect(handle.paths.some(p => p.endsWith('extra.txt'))).toBe(true)

      await writeFile(join(fixture.dir, 'data/extra.txt'), 'two')
      await until(async () => {
        const doc = await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')
        expect(doc).toContain('"two"')
      }, activity)
    } finally {
      process.chdir(cwd)
      await builder.close()
    }
  })

  fixtureTest('a builder stays usable after close', async ({ fixture }) => {
    // close() aborts the signal loaders receive; a later build must not
    // inherit it.
    await fixture.write(
      'contentmap.config.ts',
      `import { defineConfig, defineCollection, http } from ${JSON.stringify(SRC)}
import { z } from 'zod'
const news = defineCollection({
  name: 'news',
  loader: http({
    url: 'https://x.invalid/n',
    select: p => p.items,
    id: r => r.slug,
    revalidate: 'always',
    fetch: async (_u, init) => {
      if (init?.signal?.aborted) throw new Error('signal was already aborted')
      return new Response(JSON.stringify({ items: [{ slug: 'a', title: 'One' }] }), { status: 200 })
    }
  }),
  schema: z.object({ slug: z.string(), title: z.string() })
})
export default defineConfig({ collections: { news } })
`
    )
    const builder = createBuilder({ root: fixture.dir })
    await builder.build()
    await builder.watch({ debounce: 20 })
    await builder.close()

    const again = await builder.build()
    expect(again.errors).toBe(0)
    expect(again.documents).toBe(1)
  })
})
