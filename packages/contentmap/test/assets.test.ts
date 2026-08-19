import { describe, expect, it } from 'vitest'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBuilder } from '../src/builder.ts'
import { expandTemplate, isRelativeUrl, rewriteHtml, splitUrl } from '../src/assets/index.ts'
import { fixtureTest } from './helpers.ts'

const SRC = pathToFileURL(resolve(import.meta.dirname, '../src/index.ts')).href
const MARKDOWN_SRC = pathToFileURL(resolve(import.meta.dirname, '../../markdown/src/index.ts')).href
const IMAGE_SRC = pathToFileURL(resolve(import.meta.dirname, '../../image/src/index.ts')).href

// A real 1x1 PNG, so image-size has something valid to measure.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
// A 2x1 GIF, distinguishable from the PNG.
const GIF = Buffer.from('R0lGODlhAgABAIAAAP///wAAACH5BAAAAAAALAAAAAACAAEAAAICRAEAOw==', 'base64')

describe('url classification', () => {
  it('treats document-relative paths as ours', () => {
    expect(isRelativeUrl('img.png')).toBe(true)
    expect(isRelativeUrl('./a/img.png')).toBe(true)
    expect(isRelativeUrl('../img.png')).toBe(true)
  })

  it('leaves everything the author addressed elsewhere alone', () => {
    for (const url of [
      'https://x.com/a.png',
      '//cdn.x/a.png',
      '/rooted.png',
      '#anchor',
      '?query',
      'mailto:a@b.c',
      'data:image/png;base64,AAA'
    ]) {
      expect(isRelativeUrl(url), url).toBe(false)
    }
  })

  it('splits query and hash off, keeping them for the rewritten url', () => {
    expect(splitUrl('a.png?v=2#x')).toEqual({ path: 'a.png', suffix: '?v=2#x' })
    expect(splitUrl('a.png')).toEqual({ path: 'a.png', suffix: '' })
  })
})

describe('naming', () => {
  it('expands name, hash and ext with optional lengths', () => {
    expect(expandTemplate('[name]-[hash:8].[ext]', '/a/hero.PNG', 'abcdef1234567890')).toBe(
      'hero-abcdef12.png'
    )
    expect(expandTemplate('[hash].[ext]', '/a/x.jpg', 'ff00')).toBe('ff00.jpg')
  })

  it('sanitises names that would be unsafe in a url or on disk', () => {
    expect(expandTemplate('[name].[ext]', '/a/my photo (1).png', 'abc')).toBe('my-photo-1.png')
  })
})

describe('html rewriting', () => {
  const handlers = {
    resolve: async (url: string) =>
      isRelativeUrl(url) && (url.endsWith('.png') || url.endsWith('.mp4'))
        ? {
            src: `/out/${url.replace(/\W/g, '_')}`,
            sourcePath: `/src/${url}`,
            ...(url.endsWith('.png') ? { width: 10, height: 20 } : {})
          }
        : undefined
  }

  it('rewrites each url attribute independently', async () => {
    // Velite writes the matched url into EVERY url-bearing attribute of the
    // element, so the poster is replaced by the video source and destroyed.
    const { html } = await rewriteHtml('<video poster="a.png" src="b.mp4"></video>', handlers)
    expect(html).toContain('poster="/out/a_png"')
    expect(html).toContain('src="/out/b_mp4"')
  })

  it('adds intrinsic dimensions to body images', async () => {
    const { html } = await rewriteHtml('<img src="a.png" alt="x">', handlers)
    expect(html).toContain('width="10"')
    expect(html).toContain('height="20"')
  })

  it('never overrides dimensions the author set', async () => {
    const { html } = await rewriteHtml('<img src="a.png" width="5">', handlers)
    expect(html).not.toContain('width="10"')
  })

  it('rewrites each srcset candidate, preserving descriptors', async () => {
    const { html } = await rewriteHtml('<img srcset="a.png 1x, b.mp4 2x">', handlers)
    expect(html).toContain('/out/a_png 1x')
    expect(html).toContain('/out/b_mp4 2x')
  })

  it('leaves unresolvable urls untouched', async () => {
    const input = '<a href="./other.md">doc</a><img src="https://x/a.png">'
    const { html } = await rewriteHtml(input, handlers)
    expect(html).toBe(input)
  })

  it('reports every source path it referenced', async () => {
    const { referenced } = await rewriteHtml('<img src="a.png"><video src="b.mp4">', handlers)
    expect(referenced).toEqual(['/src/a.png', '/src/b.mp4'])
  })
})

// ── the M4 gate ──────────────────────────────────────────────────────────────
const config = (extra: string, withImages = true): string =>
  `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}\n` +
  `import { markdown } from ${JSON.stringify(MARKDOWN_SRC)}\n` +
  (withImages ? `import { image } from ${JSON.stringify(IMAGE_SRC)}\n` : '') +
  `import { z } from 'zod'\n\n${extra}\n`

const COLLECTION = (transform: string) => `
const posts = defineCollection({
  name: 'posts', directory: 'content', include: '**/*.md',
  schema: z.object({ title: z.string(), cover: z.string().optional() }),
  transform: ${transform}
})`

describe('asset pipeline', () => {
  fixtureTest('copies content-addressed and rewrites the body', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      config(
        COLLECTION('async (doc, ctx) => ({ title: doc.title, html: await ctx.markdown() })') +
          `\nexport default defineConfig({ collections: { posts }, renderer: markdown(), images: image() })`
      )
    )
    await fixture.writeBytes('content/hero.png', PNG)
    await fixture.write('content/a.md', '---\ntitle: A\n---\n\n![hero](hero.png)')

    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBe(0)

    const doc = await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')
    // emitted output is JS, so quotes inside the html string are escaped
    expect(doc).toMatch(/\/_content\/hero-[0-9a-f]{8}\.png/)
    // Intrinsic dimensions for a body image — velite issue #98, open since 2024.
    expect(doc).toContain('width=\\"1\\"')
    expect(doc).toContain('height=\\"1\\"')

    const emitted = await readFile(
      join(fixture.dir, 'public/_content', /hero-[0-9a-f]{8}\.png/.exec(doc)![0]),
      null
    )
    expect(emitted.equals(PNG)).toBe(true)
  })

  fixtureTest('a markdown-to-markdown link never breaks the build', async ({ fixture }) => {
    // Velite feeds any relative href to the asset pipeline, so this is
    // readFile -> ENOENT -> fatal, and the whole record is dropped.
    await fixture.write(
      'contentmap.config.ts',
      config(
        COLLECTION('async (doc, ctx) => ({ title: doc.title, html: await ctx.markdown() })') +
          `\nexport default defineConfig({ collections: { posts }, renderer: markdown(), images: image() })`
      )
    )
    await fixture.write('content/a.md', '---\ntitle: A\n---\n\n[see](./other.md) and [up](../x.md)')
    await fixture.write('content/other.md', '---\ntitle: Other\n---\nx')

    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBe(0)
    expect(result.documents).toBe(2)
    const doc = await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')
    expect(doc).toContain('./other.md')
  })

  fixtureTest('ctx.image() measures and produces a placeholder', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      config(
        COLLECTION(
          'async (doc, ctx) => ({ title: doc.title, cover: await ctx.image(doc.cover ?? "hero.png") })'
        ) + `\nexport default defineConfig({ collections: { posts }, renderer: markdown(), images: image() })`
      )
    )
    await fixture.writeBytes('content/hero.png', PNG)
    await fixture.write('content/a.md', '---\ntitle: A\ncover: hero.png\n---\nx')

    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBe(0)
    const doc = await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')
    expect(doc).toContain('width: 1')
    expect(doc).toContain('format: "png"')
    // sharp is optional; when present we also get a thumbhash data URI.
    expect(doc).toMatch(/placeholder: "data:image\/png;base64,|aspectRatio/)
  })

  fixtureTest('deleting content removes its assets', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      config(
        COLLECTION('async (doc, ctx) => ({ title: doc.title, html: await ctx.markdown() })') +
          `\nexport default defineConfig({ collections: { posts }, renderer: markdown(), images: image() })`
      )
    )
    await fixture.writeBytes('content/hero.png', PNG)
    await fixture.writeBytes('content/other.gif', GIF)
    await fixture.write('content/a.md', '---\ntitle: A\n---\n![h](hero.png)')
    await fixture.write('content/b.md', '---\ntitle: B\n---\n![o](other.gif)')

    const builder = createBuilder({ root: fixture.dir })
    await builder.build()
    const before = await readFile(join(fixture.dir, '.contentmap/posts/b.js'), 'utf8')
    const gifName = /other-[0-9a-f]{8}\.gif/.exec(before)![0]
    await expect(stat(join(fixture.dir, 'public/_content', gifName))).resolves.toBeTruthy()

    // Remove the document that owned it.
    await rm(join(fixture.dir, 'content/b.md'))
    await builder.build()

    // velite leaves these behind forever.
    await expect(stat(join(fixture.dir, 'public/_content', gifName))).rejects.toThrow()
    // The asset the surviving document still uses must remain.
    const a = await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')
    const pngName = /hero-[0-9a-f]{8}\.png/.exec(a)![0]
    await expect(stat(join(fixture.dir, 'public/_content', pngName))).resolves.toBeTruthy()
  })

  fixtureTest('a changed image invalidates the documents that reference it', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      config(
        COLLECTION('async (doc, ctx) => ({ title: doc.title, html: await ctx.markdown() })') +
          `\nexport default defineConfig({ collections: { posts }, renderer: markdown(), images: image() })`
      )
    )
    await fixture.writeBytes('content/hero.png', PNG)
    await fixture.write('content/a.md', '---\ntitle: A\n---\n![h](hero.png)')

    const builder = createBuilder({ root: fixture.dir })
    await builder.build()
    const first = /hero-[0-9a-f]{8}\.png/.exec(
      await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')
    )![0]

    // Replace the image. The markdown file is untouched, so velite's
    // content-file-only invalidation keeps serving the old fingerprint.
    await new Promise(r => setTimeout(r, 10))
    await writeFile(join(fixture.dir, 'content/hero.png'), GIF)
    await builder.build()

    const second = /hero-[0-9a-f]{8}\.(png|gif)/.exec(
      await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')
    )![0]
    expect(second).not.toBe(first)
    await expect(stat(join(fixture.dir, 'public/_content', second))).resolves.toBeTruthy()
    await expect(stat(join(fixture.dir, 'public/_content', first))).rejects.toThrow()
  })

  fixtureTest('works without an image processor, degrading to a plain copy', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      config(
        COLLECTION('async (doc, ctx) => ({ title: doc.title, logo: await ctx.asset("hero.png") })') +
          `\nexport default defineConfig({ collections: { posts }, renderer: markdown() })`,
        false
      )
    )
    await fixture.writeBytes('content/hero.png', PNG)
    await fixture.write('content/a.md', '---\ntitle: A\n---\nx')

    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBe(0)
    const doc = await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')
    expect(doc).toMatch(/logo: "\/_content\/hero-[0-9a-f]{8}\.png"/)
  })

  fixtureTest('a missing asset names the file rather than crashing', async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      config(
        COLLECTION('async (doc, ctx) => ({ title: doc.title, logo: await ctx.asset("nope.png") })') +
          `\nexport default defineConfig({ collections: { posts }, renderer: markdown(), images: image() })`
      )
    )
    await fixture.write('content/a.md', '---\ntitle: A\n---\nx')

    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBeGreaterThan(0)
    const d = result.diagnostics.find(x => x.code === 'CM_TRANSFORM')
    expect(d?.file).toBe('a.md')
  })
})
