import { describe, expect, it } from 'vitest'
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBuilder } from '../src/builder.ts'
import { moduleNameFor } from '../src/write/serialize.ts'
import { fixtureTest } from './helpers.ts'

const SRC = pathToFileURL(resolve(import.meta.dirname, '../src/index.ts')).href
const MARKDOWN_SRC = pathToFileURL(resolve(import.meta.dirname, '../../markdown/src/index.ts')).href
const config = (body: string): string =>
  `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}\n` +
  `import { z } from 'zod'\n\n${body}\n`

const POSTS = (extra = '') => `
const posts = defineCollection({
  name: 'posts', directory: 'content', include: '**/*.md',${extra}
  schema: z.object({ title: z.string().max(20), content: z.string() })
})
export default defineConfig({ collections: { posts } })`

describe('incremental correctness', () => {
  fixtureTest(
    'does not resurrect a stale document when an edit breaks validation',
    async ({ fixture }) => {
      await fixture.write('contentmap.config.ts', config(POSTS()))
      await fixture.write('content/a.md', '---\ntitle: Good\n---\nbody')
      const builder = createBuilder({ root: fixture.dir, onValidationError: 'skip' })

      const first = await builder.build()
      expect(first.documents).toBe(1)
      expect(await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')).toContain('Good')

      // Same path, now invalid. The document must disappear — not silently fall
      // back to the previously cached version.
      await new Promise(r => setTimeout(r, 10))
      await writeFile(
        join(fixture.dir, 'content/a.md'),
        '---\ntitle: This title is far too long to pass\n---\nbody'
      )
      const second = await builder.build()
      expect(second.documents).toBe(0)
      const index = await readFile(join(fixture.dir, '.contentmap/posts/index.js'), 'utf8')
      expect(index).not.toContain('Good')
    }
  )

  fixtureTest(
    'drops documents whose file was deleted, and removes the module',
    async ({ fixture }) => {
      await fixture.write('contentmap.config.ts', config(POSTS()))
      await fixture.write('content/a.md', '---\ntitle: A\n---\nx')
      await fixture.write('content/b.md', '---\ntitle: B\n---\nx')
      const builder = createBuilder({ root: fixture.dir })
      expect((await builder.build()).documents).toBe(2)

      await rm(join(fixture.dir, 'content/b.md'))
      const second = await builder.build()
      expect(second.documents).toBe(1)
      // Orphaned module files bloat deploys and confuse anyone reading dist.
      await expect(stat(join(fixture.dir, '.contentmap/posts/b.js'))).rejects.toThrow()
      await expect(stat(join(fixture.dir, '.contentmap/posts/a.js'))).resolves.toBeTruthy()
    }
  )

  fixtureTest('detects duplicate document ids instead of overwriting', async ({ fixture }) => {
    // `a.md` and `a/index.md` both resolve to the id "a".
    await fixture.write('contentmap.config.ts', config(POSTS()))
    await fixture.write('content/a.md', '---\ntitle: Flat\n---\nx')
    await fixture.write('content/a/index.md', '---\ntitle: Nested\n---\nx')
    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.diagnostics.some(d => d.code === 'CM_DUPLICATE_ID')).toBe(true)
    expect(result.errors).toBeGreaterThan(0)
  })
})

describe('severity policy', () => {
  const invalid = '---\ntitle: This title is far too long to pass\n---\nx'

  fixtureTest("'skip' drops the document but does not fail the build", async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(POSTS()))
    await fixture.write('content/bad.md', invalid)
    await fixture.write('content/ok.md', '---\ntitle: OK\n---\nx')
    const r = await createBuilder({ root: fixture.dir, onValidationError: 'skip' }).build()
    expect(r.errors).toBe(0)
    expect(r.warnings).toBeGreaterThan(0)
    expect(r.documents).toBe(1)
  })

  fixtureTest("'ignore' is silent and drops the document", async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(POSTS()))
    await fixture.write('content/bad.md', invalid)
    const r = await createBuilder({ root: fixture.dir, onValidationError: 'ignore' }).build()
    expect(r.errors).toBe(0)
    expect(r.diagnostics.filter(d => d.code === 'CM_VALIDATION')).toHaveLength(0)
    expect(r.documents).toBe(0)
  })
})

describe('unknown fields', () => {
  fixtureTest('reports a frontmatter key the schema discarded', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(POSTS()))
    await fixture.write('content/a.md', '---\ntitle: A\ncatgeory: news\n---\nx')
    const r = await createBuilder({ root: fixture.dir }).build()
    const d = r.diagnostics.find(x => x.code === 'CM_UNKNOWN_FIELD')
    expect(d?.field).toBe('catgeory')
    expect(d?.severity).toBe('warning')
    expect(r.documents).toBe(1)
  })

  fixtureTest('never flags the injected body field', async ({ fixture }) => {
    // A schema that does not declare `content` still gets a body injected; that
    // is our doing, so it must not be blamed on the author.
    await fixture.write(
      'contentmap.config.ts',
      config(`
const posts = defineCollection({
  name: 'posts', directory: 'content', include: '**/*.md',
  schema: z.object({ title: z.string() })
})
export default defineConfig({ collections: { posts } })`)
    )
    await fixture.write('content/a.md', '---\ntitle: A\n---\nbody text')
    const r = await createBuilder({ root: fixture.dir }).build()
    expect(r.diagnostics.filter(d => d.code === 'CM_UNKNOWN_FIELD')).toHaveLength(0)
  })
})

describe('emission modes', () => {
  fixtureTest('bundle mode still constructs a Query, not a bare array', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(POSTS()))
    await fixture.write('content/a.md', '---\ntitle: A\n---\nbody A')
    const r = await createBuilder({ root: fixture.dir, format: 'bundle' }).build()
    expect(r.errors).toBe(0)

    // The emitted .d.ts declares Query for every collection, so bundle output
    // must not hand back a bare array. Assert on the emitted source rather than
    // importing it: the module resolves `contentmap/runtime` from the consuming
    // app, which a temp fixture has no node_modules for.
    const source = await readFile(join(fixture.dir, '.contentmap/posts/index.js'), 'utf8')
    expect(source).toContain("import { collection } from 'contentmap/runtime'")
    expect(source).toContain('= collection(index, modules)')
    // Documents are inlined, so the index carries bodies and modules is empty.
    expect(source).toContain('body A')
    expect(source).toMatch(/const modules = \{\s*\}/)
  })

  fixtureTest('single collections emit a scalar', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      config(`
const site = defineCollection({
  name: 'site', directory: 'content', include: 'site.yaml', single: true,
  schema: z.object({ name: z.string() })
})
export default defineConfig({ collections: { site } })`)
    )
    await fixture.write('content/site.yaml', 'name: My Site')
    const r = await createBuilder({ root: fixture.dir }).build()
    expect(r.errors).toBe(0)

    // A singleton emits a plain object and imports nothing.
    const source = await readFile(join(fixture.dir, '.contentmap/site/index.js'), 'utf8')
    expect(source).not.toContain('contentmap/runtime')
    expect(source).toContain('export const site = {')
    expect(source).toContain('"My Site"')
    const dts = await readFile(join(fixture.dir, '.contentmap/index.d.ts'), 'utf8')
    expect(dts).toContain('export declare const site: Site')
    expect(dts).not.toContain('Query<Site')
  })

  fixtureTest('a single collection matching several files is an error', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      config(`
const site = defineCollection({
  name: 'site', directory: 'content', include: '*.yaml', single: true,
  schema: z.object({ name: z.string() })
})
export default defineConfig({ collections: { site } })`)
    )
    await fixture.write('content/a.yaml', 'name: A')
    await fixture.write('content/b.yaml', 'name: B')
    const r = await createBuilder({ root: fixture.dir }).build()
    expect(r.diagnostics.some(d => d.code === 'CM_SINGLETON')).toBe(true)
  })

  fixtureTest('sort reorders emitted documents', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      config(`
const posts = defineCollection({
  name: 'posts', directory: 'content', include: '**/*.md',
  schema: z.object({ title: z.string(), order: z.number(), content: z.string() }),
  sort: (a, b) => b.order - a.order
})
export default defineConfig({ collections: { posts } })`)
    )
    await fixture.write('content/a.md', '---\ntitle: A\norder: 1\n---\nx')
    await fixture.write('content/b.md', '---\ntitle: B\norder: 2\n---\nx')
    const r = await createBuilder({ root: fixture.dir }).build()
    expect(r.errors).toBe(0)
    const index = await readFile(join(fixture.dir, '.contentmap/posts/index.js'), 'utf8')
    expect(index.indexOf('"B"')).toBeLessThan(index.indexOf('"A"'))
  })
})

describe('check / dry run', () => {
  fixtureTest('validates without writing anything', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(POSTS()))
    await fixture.write('content/a.md', '---\ntitle: A\n---\nx')
    const r = await createBuilder({ root: fixture.dir, dryRun: true }).build()
    expect(r.errors).toBe(0)
    expect(r.documents).toBe(1)
    await expect(stat(join(fixture.dir, '.contentmap'))).rejects.toThrow()
  })

  fixtureTest('still reports validation errors in dry run', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(POSTS()))
    await fixture.write('content/bad.md', '---\ntitle: This title is far too long to pass\n---\nx')
    const r = await createBuilder({ root: fixture.dir, dryRun: true }).build()
    expect(r.errors).toBeGreaterThan(0)
  })
})

describe('config guards', () => {
  const bad =
    (body: string) =>
    async ({
      fixture
    }: {
      fixture: { dir: string; write: (p: string, c: string) => Promise<string> }
    }) => {
      await fixture.write('contentmap.config.ts', config(body))
      return createBuilder({ root: fixture.dir }).build()
    }

  fixtureTest('rejects two collections with the same name', async ({ fixture }) => {
    await expect(
      bad(`
const one = defineCollection({ name: 'posts', directory: 'content', include: '*.md', schema: z.object({ t: z.string() }) })
const two = defineCollection({ name: 'posts', directory: 'other', include: '*.md', schema: z.object({ t: z.string() }) })
export default defineConfig({ collections: { one, two } })`)({ fixture })
    ).rejects.toThrow(/both named "posts"/)
  })

  fixtureTest('rejects a reserved collection name', async ({ fixture }) => {
    await expect(
      bad(`
const a = defineCollection({ name: 'default', directory: 'content', include: '*.md', schema: z.object({ t: z.string() }) })
export default defineConfig({ collections: { a } })`)({ fixture })
    ).rejects.toThrow(/reserved/)
  })

  fixtureTest('rejects a field listed in both index and heavy', async ({ fixture }) => {
    await expect(
      bad(`
const a = defineCollection({ name: 'a', directory: 'content', include: '*.md',
  index: ['body'], heavy: ['body'], schema: z.object({ t: z.string() }) })
export default defineConfig({ collections: { a } })`)({ fixture })
    ).rejects.toThrow(/both `index` and `heavy`/)
  })

  fixtureTest(
    "rejects output.types: 'explicit' rather than silently ignoring it",
    async ({ fixture }) => {
      await expect(
        bad(`
const a = defineCollection({ name: 'a', directory: 'content', include: '*.md', schema: z.object({ t: z.string() }) })
export default defineConfig({ collections: { a }, output: { types: 'explicit' } })`)({ fixture })
      ).rejects.toThrow(/not implemented/)
    }
  )
})

describe('transform context', () => {
  const withRenderer = (extra: string) =>
    `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}\n` +
    `import { markdown } from ${JSON.stringify(MARKDOWN_SRC)}\n` +
    `import { z } from 'zod'\n\n${extra}\n`

  fixtureTest('gives the transform the body even when the schema drops it', async ({ fixture }) => {
    // Most schemas do NOT declare `content` — the body is reached through
    // ctx.markdown(). Reading it back out of the validated document meant the
    // validator had already stripped it, so ctx.body was empty, markdown()
    // returned "" and readingTime() reported 0 words. Silently, exit 0.
    await fixture.write(
      'contentmap.config.ts',
      withRenderer(`
const posts = defineCollection({
  name: 'posts', directory: 'content', include: '**/*.md',
  schema: z.object({ title: z.string() }),
  transform: async (doc, ctx) => ({
    title: doc.title,
    bodyLength: ctx.body.length,
    html: await ctx.markdown(),
    words: (await ctx.readingTime()).words
  })
})
export default defineConfig({ collections: { posts }, renderer: markdown() })`)
    )
    await fixture.write('content/a.md', '---\ntitle: A\n---\n\nOne two three four five.')

    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBe(0)

    const source = await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')
    expect(source).toContain('bodyLength: 24')
    expect(source).toContain('words: 5')
    expect(source).toContain('<p>One two three four five.</p>')
  })

  fixtureTest(
    'reports an unserializable transform result against its file',
    async ({ fixture }) => {
      await fixture.write(
        'contentmap.config.ts',
        withRenderer(`
const posts = defineCollection({
  name: 'posts', directory: 'content', include: '**/*.md',
  schema: z.object({ title: z.string() }),
  transform: (doc) => ({ title: doc.title, render: () => 'nope' })
})
export default defineConfig({ collections: { posts }, renderer: markdown() })`)
      )
      await fixture.write('content/a.md', '---\ntitle: A\n---\nbody')

      const result = await createBuilder({ root: fixture.dir }).build()
      expect(result.errors).toBeGreaterThan(0)
      const d = result.diagnostics.find(x => x.code === 'CM_SERIALIZE')
      expect(d?.file).toBe('a.md')
      expect(d?.message).toMatch(/function/i)
    }
  )
})

describe('module names cannot collide', () => {
  it('leaves an already-safe id readable', () => {
    // No digest suffix for the common case, or every filename in the output
    // directory becomes unreadable to buy safety almost nobody needs.
    expect(moduleNameFor('hello-world')).toBe('hello-world')
    expect(moduleNameFor('posts.2024')).toBe('posts.2024')
    // Nested documents are universal, so a slash flattens without a suffix.
    // Suffixing them would rename every file in the output directory of every
    // project that has a subdirectory, to guard a case nobody has hit.
    expect(moduleNameFor('a/b')).toBe('a__b')
  })

  it('distinguishes ids that sanitise to the same string', () => {
    // `a b` and `a+b` both became `a__b`, as did every pair of non-latin
    // filenames, since the whole name collapses to `__`. Two documents then
    // raced to write one path and the build died on a rename.
    const pairs = [
      ['a b', 'a+b'],
      ['日本語', '中文'],
      ['hello(world)', 'hello world'],
      ['Привет', 'مرحبا']
    ]
    for (const [x, y] of pairs) {
      expect(moduleNameFor(x), `${x} vs ${y}`).not.toBe(moduleNameFor(y))
    }
  })

  fixtureTest(
    'reports the residual collision rather than racing for the file',
    async ({ fixture }) => {
      // `a/b` flattens to `a__b`, so a file literally named `a__b` beside a
      // directory `a/` still collides. Vanishingly rare, and previously an ENOENT
      // naming a temp file. Now it says what happened.
      await fixture.write(
        'contentmap.config.ts',
        `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}
import { z } from 'zod'
const posts = defineCollection({
  directory: 'content', include: '**/*.md', schema: z.object({ title: z.string() })
})
export default defineConfig({ collections: { posts } })
`
      )
      await fixture.write('content/a/b.md', '---\ntitle: Nested\n---\nx')
      await fixture.write('content/a__b.md', '---\ntitle: Flat\n---\nx')

      const result = await createBuilder({ root: fixture.dir }).build()

      expect(result.errors).toBe(1)
      const clash = result.diagnostics.find(d => d.code === 'CM_MODULE_COLLISION')
      expect(clash?.message).toContain('both emit the module')
    }
  )

  it('is stable for the same id', () => {
    // The filename is referenced from the index, so it has to be a pure
    // function of the id and not of anything about this build.
    expect(moduleNameFor('日本語')).toBe(moduleNameFor('日本語'))
  })

  it('never starts with a digit', () => {
    expect(moduleNameFor('2024-review')).toMatch(/^[_A-Za-z]/)
    expect(moduleNameFor('2024 review')).toMatch(/^[_A-Za-z]/)
  })
})

describe('documents whose filenames differ only in punctuation', () => {
  fixtureTest('all reach the output', async ({ fixture }) => {
    // A space and a plus are ordinary filenames. Both used to produce the same
    // module path, and the build failed on an ENOENT naming a temp file.
    await fixture.write(
      'contentmap.config.ts',
      `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}
import { z } from 'zod'
const posts = defineCollection({
  directory: 'content', include: '**/*.md', schema: z.object({ title: z.string() })
})
export default defineConfig({ collections: { posts } })
`
    )
    await fixture.write('content/a b.md', '---\ntitle: Space\n---\nx')
    await fixture.write('content/a+b.md', '---\ntitle: Plus\n---\nx')
    await fixture.write('content/日本語.md', '---\ntitle: Japanese\n---\nx')
    await fixture.write('content/中文.md', '---\ntitle: Chinese\n---\nx')

    const result = await createBuilder({ root: fixture.dir }).build()

    expect(result.errors).toBe(0)
    expect(result.documents).toBe(4)
    const modules = (await readdir(join(fixture.dir, '.contentmap/posts'))).filter(
      f => f !== 'index.js'
    )
    expect(new Set(modules).size, `distinct modules: ${modules}`).toBe(4)
  })
})
