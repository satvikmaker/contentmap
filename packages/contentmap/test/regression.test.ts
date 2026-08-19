import { describe, expect, it } from 'vitest'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBuilder } from '../src/builder.ts'
import { fixtureTest } from './helpers.ts'

const SRC = pathToFileURL(resolve(import.meta.dirname, '../src/index.ts')).href
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
  fixtureTest('does not resurrect a stale document when an edit breaks validation', async ({ fixture }) => {
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
  })

  fixtureTest('drops documents whose file was deleted, and removes the module', async ({ fixture }) => {
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
  })

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
  const bad = (body: string) => async ({ fixture }: { fixture: { dir: string; write: (p: string, c: string) => Promise<string> } }) => {
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

  fixtureTest("rejects output.types: 'explicit' rather than silently ignoring it", async ({ fixture }) => {
    await expect(
      bad(`
const a = defineCollection({ name: 'a', directory: 'content', include: '*.md', schema: z.object({ t: z.string() }) })
export default defineConfig({ collections: { a }, output: { types: 'explicit' } })`)({ fixture })
    ).rejects.toThrow(/not implemented/)
  })
})
