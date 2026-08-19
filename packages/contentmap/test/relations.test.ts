import { describe, expect, it } from 'vitest'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBuilder } from '../src/builder.ts'
import { decode, encode } from '../src/cache/codec.ts'
import { fixtureTest } from './helpers.ts'

const SRC = pathToFileURL(resolve(import.meta.dirname, '../src/index.ts')).href

const head = `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}\nimport { z } from 'zod'\n`

const AUTHORS = `
const authors = defineCollection({
  name: 'authors', directory: 'content/authors', include: '**/*.yaml',
  schema: z.object({ name: z.string() }),
  transform: (doc) => ({ name: doc.name, tag: 'TRANSFORMED' })
})`

const POSTS = (body: string) => `
const posts = defineCollection({
  name: 'posts', directory: 'content/posts', include: '**/*.md',
  schema: z.object({ title: z.string(), author: z.string().optional(), authors: z.array(z.string()).optional() }),
  transform: ${body}
})`

async function seed(fixture: { write: (p: string, c: string) => Promise<string> }) {
  await fixture.write('content/authors/jane.yaml', 'name: Jane')
  await fixture.write('content/authors/bob.yaml', 'name: Bob')
  await fixture.write('content/posts/a.md', '---\ntitle: A\nauthor: jane\n---\nbody')
}

describe('cross-collection references', () => {
  fixtureTest('order in the config does not change the output', async ({ fixture }) => {
    // content-collections mutates a shared array in a sequential loop, so
    // `documents()` returns transformed docs when the target appears earlier
    // and untransformed ones when it appears later (their issue #396).
    const transform =
      'async (doc, ctx) => ({ title: doc.title, author: await ctx.resolve(authors, doc.author ?? "jane") })'

    const outputs: string[] = []
    for (const order of ['{ authors, posts }', '{ posts, authors }']) {
      await fixture.write(
        'contentmap.config.ts',
        `${head}${AUTHORS}${POSTS(transform)}\nexport default defineConfig({ collections: ${order} })`
      )
      await seed(fixture)
      await rm(join(fixture.dir, '.contentmap'), { recursive: true, force: true })
      const result = await createBuilder({ root: fixture.dir }).build()
      expect(result.errors).toBe(0)
      outputs.push(await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8'))
    }

    expect(outputs[0]).toBe(outputs[1])
    // and both embed the TRANSFORMED author, never the raw schema output
    expect(outputs[0]).toContain('TRANSFORMED')
  })

  fixtureTest('a broken scalar reference fails the build, naming the file', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      `${head}${AUTHORS}${POSTS('async (doc, ctx) => ({ title: doc.title, author: await ctx.resolve(authors, doc.author ?? "") })')}\nexport default defineConfig({ collections: { authors, posts } })`
    )
    await seed(fixture)
    await fixture.write('content/posts/bad.md', '---\ntitle: Bad\nauthor: ghost\n---\nx')

    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBeGreaterThan(0)
    const d = result.diagnostics.find(x => x.file === 'bad.md')
    expect(d?.message).toMatch(/"ghost" not found in collection "authors"/)
  })

  fixtureTest('a broken reference INSIDE A LIST is caught too', async ({ fixture }) => {
    // Contentlayer validates only the scalar case; its source carries
    // `// TODO also check for references in lists`, so this passes silently
    // and the generated types claim documents that do not exist.
    await fixture.write(
      'contentmap.config.ts',
      `${head}${AUTHORS}${POSTS('async (doc, ctx) => ({ title: doc.title, authors: await ctx.resolveMany(authors, doc.authors ?? []) })')}\nexport default defineConfig({ collections: { authors, posts } })`
    )
    await seed(fixture)
    await fixture.write('content/posts/list.md', '---\ntitle: L\nauthors: [jane, ghost, phantom]\n---\nx')

    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBeGreaterThan(0)
    const d = result.diagnostics.find(x => x.file === 'list.md')
    // every missing id, not just the first
    expect(d?.message).toContain('ghost')
    expect(d?.message).toContain('phantom')
  })

  fixtureTest('suggests a near miss', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      `${head}${AUTHORS}${POSTS('async (doc, ctx) => ({ title: doc.title, author: await ctx.resolve(authors, doc.author ?? "") })')}\nexport default defineConfig({ collections: { authors, posts } })`
    )
    await seed(fixture)
    await fixture.write('content/posts/typo.md', '---\ntitle: T\nauthor: jame\n---\nx')
    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.diagnostics.find(x => x.file === 'typo.md')?.hint).toMatch(/jane/)
  })

  fixtureTest('an embedded document does not leak build-internal fields', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      `${head}${AUTHORS}${POSTS('async (doc, ctx) => ({ title: doc.title, author: await ctx.resolve(authors, "jane") })')}\nexport default defineConfig({ collections: { authors, posts } })`
    )
    await seed(fixture)
    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBe(0)
    const doc = await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')
    // `digest` is stripped from a document's own _meta; embedding must not
    // put it straight back into the output.
    expect(doc).not.toContain('digest')
  })

  fixtureTest('reference() validates without embedding', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      `${head}${AUTHORS}${POSTS('async (doc, ctx) => ({ title: doc.title, authorId: await ctx.reference(authors, doc.author ?? "jane") })')}\nexport default defineConfig({ collections: { authors, posts } })`
    )
    await seed(fixture)
    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBe(0)
    const doc = await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')
    expect(doc).toContain('authorId: "jane"')
    expect(doc).not.toContain('TRANSFORMED')
  })

  fixtureTest('detects a cycle and names both collections', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      `${head}
const a = defineCollection({
  name: 'a', directory: 'content/a', include: '**/*.md',
  schema: z.object({ title: z.string() }),
  transform: async (doc, ctx) => ({ title: doc.title, other: (await ctx.documents(b)).length })
})
const b = defineCollection({
  name: 'b', directory: 'content/b', include: '**/*.md',
  schema: z.object({ title: z.string() }),
  transform: async (doc, ctx) => ({ title: doc.title, other: (await ctx.documents(a)).length })
})
export default defineConfig({ collections: { a, b } })`
    )
    await fixture.write('content/a/x.md', '---\ntitle: X\n---\nx')
    await fixture.write('content/b/y.md', '---\ntitle: Y\n---\ny')

    await expect(createBuilder({ root: fixture.dir }).build()).rejects.toThrow(
      /Reference cycle between collections: (a -> b -> a|b -> a -> b)/
    )
  })

  fixtureTest('an unknown collection name suggests a real one', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      `${head}${AUTHORS}${POSTS('async (doc, ctx) => ({ title: doc.title, n: (await ctx.documents("authurs")).length })')}\nexport default defineConfig({ collections: { authors, posts } })`
    )
    await seed(fixture)
    const result = await createBuilder({ root: fixture.dir }).build()
    const d = result.diagnostics.find(x => x.code === 'CM_TRANSFORM')
    expect(d?.message).toMatch(/Unknown collection "authurs"/)
    expect(d?.hint).toMatch(/authors/)
  })
})

describe('reverse invalidation', () => {
  fixtureTest('editing a referenced document refreshes its referrers', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      `${head}${AUTHORS}${POSTS('async (doc, ctx) => ({ title: doc.title, author: await ctx.resolve(authors, doc.author ?? "jane") })')}\nexport default defineConfig({ collections: { authors, posts } })`
    )
    await seed(fixture)

    const builder = createBuilder({ root: fixture.dir })
    await builder.build()
    expect(await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')).toContain('"Jane"')

    // The POST is untouched; only the author changes. Contentlayer ships this
    // as a known gap: `// TODO take care of case where embedded document was
    // updated in the meantime`.
    await new Promise(r => setTimeout(r, 10))
    await writeFile(join(fixture.dir, 'content/authors/jane.yaml'), 'name: Jane Updated')
    await builder.build()

    expect(await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')).toContain(
      '"Jane Updated"'
    )
  })

  fixtureTest('adding a document invalidates anyone reading the collection', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      `${head}${AUTHORS}${POSTS('async (doc, ctx) => ({ title: doc.title, count: (await ctx.documents(authors)).length })')}\nexport default defineConfig({ collections: { authors, posts } })`
    )
    await seed(fixture)

    const builder = createBuilder({ root: fixture.dir })
    await builder.build()
    expect(await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')).toContain('count: 2')

    await new Promise(r => setTimeout(r, 10))
    await fixture.write('content/authors/zoe.yaml', 'name: Zoe')
    await builder.build()
    expect(await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')).toContain('count: 3')
  })
})

describe('transform cache', () => {
  const CACHED = `
const posts = defineCollection({
  name: 'posts', directory: 'content/posts', include: '**/*.md',
  schema: z.object({ title: z.string() }),
  transform: async (doc, ctx) => ({
    title: doc.title,
    slow: await ctx.cache({ t: doc.title }, () => ({ at: new Date('2026-01-01'), n: 42 }))
  })
})`

  fixtureTest('persists across builder instances and keeps types', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      `${head}${CACHED}\nexport default defineConfig({ collections: { posts } })`
    )
    await fixture.write('content/posts/a.md', '---\ntitle: A\n---\nx')

    await createBuilder({ root: fixture.dir }).build()
    const cacheDir = join(fixture.dir, '.contentmap/.cache/transforms')
    expect(await readdir(cacheDir)).toEqual(['posts.json'])

    // A fresh builder must reuse the stored value, and a cached Date must
    // still be a Date rather than the string plain JSON would leave behind.
    await rm(join(fixture.dir, '.contentmap/posts'), { recursive: true, force: true })
    const second = await createBuilder({ root: fixture.dir }).build()
    expect(second.errors).toBe(0)
    const doc = await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')
    expect(doc).toContain('new Date("2026-01-01T00:00:00.000Z")')
    expect(doc).toContain('n: 42')
  })

  fixtureTest('garbage-collects entries for deleted documents', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      `${head}${CACHED}\nexport default defineConfig({ collections: { posts } })`
    )
    for (let i = 0; i < 5; i++) {
      await fixture.write(`content/posts/p${i}.md`, `---\ntitle: P${i}\n---\nx`)
    }
    const builder = createBuilder({ root: fixture.dir })
    await builder.build()

    const file = join(fixture.dir, '.contentmap/.cache/transforms/posts.json')
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8')))).toHaveLength(5)

    await rm(join(fixture.dir, 'content/posts/p0.md'))
    await rm(join(fixture.dir, 'content/posts/p1.md'))
    await builder.build()

    // content-collections never removes these; a long-lived project keeps
    // cache entries for documents that no longer exist.
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8')))).toHaveLength(3)
  })

  fixtureTest('a config change invalidates every cached value', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      `${head}${CACHED}\nexport default defineConfig({ collections: { posts } })`
    )
    await fixture.write('content/posts/a.md', '---\ntitle: A\n---\nx')
    await createBuilder({ root: fixture.dir }).build()
    const before = await readFile(join(fixture.dir, '.contentmap/.cache/transforms/posts.json'), 'utf8')

    await fixture.write(
      'contentmap.config.ts',
      `${head}${CACHED.replace('n: 42', 'n: 99')}\nexport default defineConfig({ collections: { posts } })`
    )
    await createBuilder({ root: fixture.dir }).build()
    const after = await readFile(join(fixture.dir, '.contentmap/.cache/transforms/posts.json'), 'utf8')
    expect(after).not.toBe(before)
    expect(
      await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')
    ).toContain('n: 99')
  })
})

describe('cache codec', () => {
  it('round-trips everything the serializer can emit', () => {
    const value = {
      d: new Date('2026-01-01T00:00:00.000Z'),
      m: new Map([['a', 1]]),
      s: new Set([1, 2]),
      b: 10n,
      r: /ab+c/gi,
      u: new URL('https://example.com/x'),
      n: null,
      undef: undefined,
      nested: { deep: [new Date(0)] }
    }
    const out = decode(JSON.parse(JSON.stringify(encode(value)))) as typeof value
    expect(out.d).toBeInstanceOf(Date)
    expect(out.m).toBeInstanceOf(Map)
    expect(out.s).toBeInstanceOf(Set)
    expect(out.b).toBe(10n)
    expect(out.r.source).toBe('ab+c')
    expect(out.u).toBeInstanceOf(URL)
    expect(out.n).toBeNull()
    expect(out.undef).toBeUndefined()
    expect((out.nested.deep[0] as Date).getTime()).toBe(0)
  })

  it('does not mistake a plain object with a $ key for a tag', () => {
    const out = decode(JSON.parse(JSON.stringify(encode({ $: 'not-a-tag', v: 1 })))) as Record<string, unknown>
    expect(out['$']).toBe('not-a-tag')
    expect(out['v']).toBe(1)
  })
})


describe('sibling access', () => {
  const SIBLINGS = `
const posts = defineCollection({
  name: 'posts', directory: 'content/posts', include: '**/*.md',
  schema: z.object({ title: z.string() }),
  transform: async (doc, ctx) => ({
    title: doc.title,
    related: (await ctx.siblings()).map(s => s.title)
  })
})`

  fixtureTest('gives a document the others in its own collection', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      `${head}${SIBLINGS}\nexport default defineConfig({ collections: { posts } })`
    )
    await fixture.write('content/posts/a.md', '---\ntitle: A\n---\nx')
    await fixture.write('content/posts/b.md', '---\ntitle: B\n---\nx')
    await fixture.write('content/posts/c.md', '---\ntitle: C\n---\nx')

    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBe(0)
    const a = await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')
    expect(a).toContain('"B"')
    expect(a).toContain('"C"')
    // never itself
    expect(a.match(/"A"/g)).toHaveLength(1)
  })

  fixtureTest('rebuilds siblings when a document is added', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      `${head}${SIBLINGS}\nexport default defineConfig({ collections: { posts } })`
    )
    await fixture.write('content/posts/a.md', '---\ntitle: A\n---\nx')
    const builder = createBuilder({ root: fixture.dir })
    await builder.build()
    expect(await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')).toContain(
      'related: []'
    )

    await new Promise(r => setTimeout(r, 10))
    await fixture.write('content/posts/b.md', '---\ntitle: B\n---\nx')
    await builder.build()
    expect(await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')).toContain('"B"')
  })

  fixtureTest('asking for its own collection points at siblings()', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      `${head}
const posts = defineCollection({
  name: 'posts', directory: 'content/posts', include: '**/*.md',
  schema: z.object({ title: z.string() }),
  transform: async (doc, ctx) => ({ title: doc.title, n: (await ctx.documents(posts)).length })
})
export default defineConfig({ collections: { posts } })`
    )
    await fixture.write('content/posts/a.md', '---\ntitle: A\n---\nx')

    const result = await createBuilder({ root: fixture.dir }).build()
    const d = result.diagnostics.find(x => x.code === 'CM_TRANSFORM')
    expect(d?.file).toBe('a.md')
    expect(d?.message).toMatch(/cannot read itself/)
    expect(d?.hint).toMatch(/siblings\(\)/)
  })
})

describe('reference() dependency scope', () => {
  fixtureTest('does not rebuild referrers when only the target content changes', async ({
    fixture
  }) => {
    // reference() keeps an id, not content, so it depends on the target
    // existing. Tracking content here would rebuild every referrer on any edit
    // to the target, which is the cost reference() exists to avoid.
    await fixture.write(
      'contentmap.config.ts',
      `${head}${AUTHORS}${POSTS('async (doc, ctx) => ({ title: doc.title, at: Date.now(), authorId: await ctx.reference(authors, "jane") })')}\nexport default defineConfig({ collections: { authors, posts } })`
    )
    await seed(fixture)

    const builder = createBuilder({ root: fixture.dir })
    await builder.build()
    const first = await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')

    await new Promise(r => setTimeout(r, 10))
    await writeFile(join(fixture.dir, 'content/authors/jane.yaml'), 'name: Jane Renamed')
    await builder.build()
    const second = await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')

    expect(second).toBe(first)
  })

  fixtureTest('still rebuilds when the referenced document disappears', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      `${head}${AUTHORS}${POSTS('async (doc, ctx) => ({ title: doc.title, authorId: await ctx.reference(authors, "jane") })')}\nexport default defineConfig({ collections: { authors, posts } })`
    )
    await seed(fixture)
    const builder = createBuilder({ root: fixture.dir })
    expect((await builder.build()).errors).toBe(0)

    await rm(join(fixture.dir, 'content/authors/jane.yaml'))
    const second = await builder.build()
    expect(second.errors).toBeGreaterThan(0)
    expect(second.diagnostics.some(d => d.message.includes('not found'))).toBe(true)
  })
})

describe('error fidelity', () => {
  fixtureTest('resolveMany does not repackage a structural failure', async ({ fixture }) => {
    // A cycle surfacing through resolveMany must stay a cycle, not be reported
    // as a missing id.
    await fixture.write(
      'contentmap.config.ts',
      `${head}
const a = defineCollection({
  name: 'a', directory: 'content/a', include: '**/*.md',
  schema: z.object({ title: z.string() }),
  transform: async (doc, ctx) => ({ title: doc.title, x: await ctx.resolveMany(b, ['y']) })
})
const b = defineCollection({
  name: 'b', directory: 'content/b', include: '**/*.md',
  schema: z.object({ title: z.string() }),
  transform: async (doc, ctx) => ({ title: doc.title, x: await ctx.resolveMany(a, ['x']) })
})
export default defineConfig({ collections: { a, b } })`
    )
    await fixture.write('content/a/x.md', '---\ntitle: X\n---\nx')
    await fixture.write('content/b/y.md', '---\ntitle: Y\n---\ny')

    await expect(createBuilder({ root: fixture.dir }).build()).rejects.toThrow(/Reference cycle/)
  })
})
