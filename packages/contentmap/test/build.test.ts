import { describe, expect, it } from 'vitest'
import { chmod, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBuilder } from '../src/builder.ts'
import { ConfigError } from '../src/config/resolve.ts'
import { fixtureTest } from './helpers.ts'

// Temp fixtures live outside the workspace, so `contentmap` is not resolvable
// from them. Import our source by absolute URL instead.
const SRC = pathToFileURL(resolve(import.meta.dirname, '../src/index.ts')).href
const ZOD = 'zod'

const config = (body: string): string =>
  `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}\n` +
  `import { z } from ${JSON.stringify(ZOD)}\n\n${body}\n`

const POSTS = `
const posts = defineCollection({
  name: 'posts',
  directory: 'content',
  include: '**/*.md',
  schema: z.object({ title: z.string().max(20), date: z.coerce.date(), content: z.string() })
})
export default defineConfig({ collections: { posts } })
`

describe('build pipeline', () => {
  fixtureTest('builds documents and emits per-document modules', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(POSTS))
    await fixture.write('content/a.md', '---\ntitle: A\ndate: 2026-01-01\n---\nBody A')
    await fixture.write('content/sub/b.md', '---\ntitle: B\ndate: 2026-01-02\n---\nBody B')

    const result = await createBuilder({ root: fixture.dir }).build()

    expect(result.errors).toBe(0)
    expect(result.documents).toBe(2)
    await expect(stat(join(fixture.dir, '.contentmap/posts/a.js'))).resolves.toBeTruthy()
    await expect(stat(join(fixture.dir, '.contentmap/posts/sub__b.js'))).resolves.toBeTruthy()

    const index = await readFile(join(fixture.dir, '.contentmap/posts/index.js'), 'utf8')
    expect(index).toContain("from 'contentmap/runtime'")
    // Bodies are heavy: they belong in the document module, never the index.
    expect(index).not.toContain('Body A')
  })

  fixtureTest('emits documents in a stable order', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(POSTS))
    for (const n of ['c', 'a', 'b']) {
      await fixture.write(`content/${n}.md`, `---\ntitle: ${n}\ndate: 2026-01-01\n---\nx`)
    }
    const dts = await createBuilder({ root: fixture.dir }).build()
    expect(dts.errors).toBe(0)
    const index = await readFile(join(fixture.dir, '.contentmap/posts/index.js'), 'utf8')
    expect(index.indexOf('"a"')).toBeLessThan(index.indexOf('"b"'))
    expect(index.indexOf('"b"')).toBeLessThan(index.indexOf('"c"'))
  })

  fixtureTest('yields N documents from a root-level array', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      config(`
const tags = defineCollection({
  name: 'tags', directory: 'content', include: '*.yaml',
  schema: z.object({ name: z.string() })
})
export default defineConfig({ collections: { tags } })`)
    )
    await fixture.write('content/tags.yaml', '- name: alpha\n- name: beta\n- name: gamma')
    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBe(0)
    expect(result.documents).toBe(3)
  })

  fixtureTest('dispatches parsers per file, not per collection', async ({ fixture }) => {
    // content-collections fixes one parser per collection, so this exact case
    // feeds the JSON through gray-matter and fails validation.
    await fixture.write(
      'contentmap.config.ts',
      config(`
const mixed = defineCollection({
  name: 'mixed', directory: 'content', include: ['**/*.md', '**/*.json'],
  schema: z.object({ title: z.string() })
})
export default defineConfig({ collections: { mixed } })`)
    )
    await fixture.write('content/a.md', '---\ntitle: From markdown\n---\nbody')
    await fixture.write('content/b.json', '{ "title": "From json" }')
    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBe(0)
    expect(result.documents).toBe(2)
  })

  fixtureTest('skips writes when bytes are unchanged', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(POSTS))
    await fixture.write('content/a.md', '---\ntitle: A\ndate: 2026-01-01\n---\nBody')
    const builder = createBuilder({ root: fixture.dir })
    await builder.build()
    const target = join(fixture.dir, '.contentmap/posts/a.js')
    const before = (await stat(target)).mtimeMs
    await new Promise(r => setTimeout(r, 20))
    await createBuilder({ root: fixture.dir }).build()
    // An identical rewrite would bump mtime and fire a spurious HMR update.
    expect((await stat(target)).mtimeMs).toBe(before)
  })
})

describe('correctness guarantees', () => {
  fixtureTest('fails the build on a validation error by default', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(POSTS))
    await fixture.write(
      'content/bad.md',
      '---\ntitle: This title is far too long to pass\ndate: 2026-01-01\n---\nx'
    )
    const result = await createBuilder({ root: fixture.dir }).build()

    // velite emits the violating record and exits 0; the generated .d.ts then
    // asserts a type the data does not satisfy.
    expect(result.errors).toBeGreaterThan(0)
    expect(result.documents).toBe(0)
    const d = result.diagnostics.find(x => x.code === 'CM_VALIDATION')
    expect(d?.field).toBe('title')
    expect(d?.file).toBe('bad.md')
    expect(d?.severity).toBe('error')
  })

  fixtureTest('keeps the document when validation is downgraded to warn', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(POSTS))
    await fixture.write(
      'content/bad.md',
      '---\ntitle: This title is far too long to pass\ndate: 2026-01-01\n---\nx'
    )
    const result = await createBuilder({
      root: fixture.dir,
      onValidationError: 'warn'
    }).build()
    expect(result.errors).toBe(0)
    expect(result.warnings).toBeGreaterThan(0)
    expect(result.documents).toBe(1)
  })

  // chmod(0o000) does not make a file unreadable on Windows — it maps to the
  // read-only attribute, which still permits reads — so the read this asserts
  // on simply succeeds there. The guarantee still holds on Windows; only this
  // way of provoking it does not exist.
  fixtureTest.skipIf(process.platform === 'win32')(
    'reports read failures rather than silently dropping them',
    async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(POSTS))
    await fixture.write('content/ok.md', '---\ntitle: OK\ndate: 2026-01-01\n---\nx')
    // An unreadable file matches the glob but fails to read — the same shape as
    // the fd-exhaustion case that cost content-collections 92% of a corpus.
    const locked = await fixture.write('content/locked.md', '---\ntitle: L\n---\nx')
    await chmod(locked, 0o000)

    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBeGreaterThan(0)
    expect(result.diagnostics.some(d => d.code === 'CM_READ')).toBe(true)
    }
  )

  fixtureTest('replays events to a late subscriber', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(POSTS))
    await fixture.write('content/a.md', '---\ntitle: A\ndate: 2026-01-01\n---\nx')

    const builder = createBuilder({ root: fixture.dir })
    await builder.build()

    // Subscribing AFTER the build still yields every event. This is the hole
    // that let content-collections emit 2,758 read errors into the void.
    const seen: string[] = []
    builder.on(e => seen.push(e.type))
    expect(seen).toContain('build:start')
    expect(seen).toContain('build:end')
  })

  fixtureTest('offers a did-you-mean for a misspelled field', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      config(`
const posts = defineCollection({
  name: 'posts', directory: 'content', include: '**/*.md',
  schema: z.object({ title: z.string(), category: z.string(), content: z.string() })
})
export default defineConfig({ collections: { posts } })`)
    )
    await fixture.write('content/a.md', '---\ntitle: A\ncatgeory: news\n---\nx')
    const result = await createBuilder({ root: fixture.dir }).build()
    const d = result.diagnostics.find(x => x.field === 'category')
    expect(d?.hint).toMatch(/catgeory/)
  })
})

describe('config validation', () => {
  fixtureTest('rejects colliding generated type names', async ({ fixture }) => {
    // content-collections emits `import allPosts` twice here — a SyntaxError,
    // while reporting a successful build.
    await fixture.write(
      'contentmap.config.ts',
      config(`
const post = defineCollection({ name: 'post', directory: 'content', include: '*.md', schema: z.object({ title: z.string() }) })
const posts = defineCollection({ name: 'posts', directory: 'content', include: '*.md', schema: z.object({ title: z.string() }) })
export default defineConfig({ collections: { post, posts } })`)
    )
    await expect(createBuilder({ root: fixture.dir }).build()).rejects.toThrow(/type name "Post"/)
  })

  fixtureTest('rejects a non-identifier collection name', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      config(`
const a = defineCollection({ name: 'my-posts', directory: 'content', include: '*.md', schema: z.object({ t: z.string() }) })
export default defineConfig({ collections: { a } })`)
    )
    await expect(createBuilder({ root: fixture.dir }).build()).rejects.toThrow(/valid JavaScript identifier/)
  })

  fixtureTest('rejects a schema that is not a Standard Schema', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      config(`
const a = defineCollection({ name: 'a', directory: 'content', include: '*.md', schema: { title: 'string' } })
export default defineConfig({ collections: { a } })`)
    )
    await expect(createBuilder({ root: fixture.dir }).build()).rejects.toThrow(/Standard Schema/)
  })

  fixtureTest('does not walk up to a parent directory config', async ({ fixture }) => {
    // velite recurses three levels up and can silently adopt a monorepo
    // parent's config.
    await fixture.write('contentmap.config.ts', config(POSTS))
    await fixture.write('nested/app/.keep', '')
    await expect(
      createBuilder({ root: join(fixture.dir, 'nested/app') }).build()
    ).rejects.toThrow(ConfigError)
  })
})
