import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBuilder } from '../src/builder.ts'
import { fixtureTest } from './helpers.ts'

const SRC = pathToFileURL(resolve(import.meta.dirname, '../src/index.ts')).href
const MARKDOWN = pathToFileURL(resolve(import.meta.dirname, '../../markdown/src/index.ts')).href
import { markdown } from '../../markdown/src/index.ts'
import { unifiedRenderer } from '../../unified/src/index.ts'
import {
  buildToc,
  excerptOf,
  htmlToHeadings,
  htmlToPlain,
  readingTimeOf,
  slugify
} from '../src/render/derive.ts'
import { createTransformContext, MissingRendererError } from '../src/render/context.ts'
import type { DocumentMeta, Renderer } from '../src/types.ts'

const meta: DocumentMeta = {
  id: 'a',
  filePath: 'a.md',
  fileName: 'a.md',
  directory: '.',
  extension: '.md',
  path: 'a',
  slug: 'a',
  digest: 'x'
}

const ctx = (body: string, renderer?: Renderer) =>
  createTransformContext({
    meta,
    body,
    path: '/tmp/a.md',
    renderer,
    logger: { info() {}, warn() {}, debug() {} }
  })

describe('html derivations', () => {
  it('strips markup and collapses whitespace', () => {
    expect(htmlToPlain('<p>Hello <em>there</em></p><p>World</p>')).toBe('Hello there World')
  })

  it('does not glue adjacent blocks together', () => {
    expect(htmlToPlain('<li>one</li><li>two</li>')).toBe('one two')
  })

  it('drops script and style content', () => {
    expect(htmlToPlain('<p>a</p><script>evil()</script><style>.x{}</style>')).toBe('a')
  })

  it('decodes entities, including numeric ones', () => {
    expect(htmlToPlain('<p>a &amp; b &lt;c&gt; &#65; &#x42;</p>')).toBe('a & b <c> A B')
  })

  it('extracts headings and prefers an id the renderer emitted', () => {
    const html = '<h2 id="custom">One</h2><h3>Two Words</h3>'
    expect(htmlToHeadings(html)).toEqual([
      { depth: 2, text: 'One', id: 'custom' },
      { depth: 3, text: 'Two Words', id: 'two-words' }
    ])
  })

  it('disambiguates repeated heading text', () => {
    const ids = htmlToHeadings('<h2>Setup</h2><h2>Setup</h2><h2>Setup</h2>').map(h => h.id)
    expect(ids).toEqual(['setup', 'setup-1', 'setup-2'])
  })
})

describe('slugify', () => {
  it('lowercases, strips punctuation and hyphenates', () => {
    expect(slugify('Hello, World!')).toBe('hello-world')
  })
  it('folds diacritics', () => {
    expect(slugify('Café Déjà Vu')).toBe('cafe-deja-vu')
  })
  it('keeps non-latin scripts', () => {
    expect(slugify('日本語')).toBe('日本語')
  })
})

describe('toc', () => {
  const headings = [
    { depth: 1, text: 'Title', id: 'title' },
    { depth: 2, text: 'A', id: 'a' },
    { depth: 3, text: 'A1', id: 'a1' },
    { depth: 3, text: 'A2', id: 'a2' },
    { depth: 2, text: 'B', id: 'b' },
    { depth: 4, text: 'Deep', id: 'deep' }
  ]

  it('nests by depth within the default range', () => {
    const toc = buildToc(headings)
    expect(toc.map(e => e.id)).toEqual(['a', 'b'])
    expect(toc[0]!.children.map(e => e.id)).toEqual(['a1', 'a2'])
  })

  it('honours an explicit depth range', () => {
    expect(buildToc(headings, { minDepth: 1, maxDepth: 1 }).map(e => e.id)).toEqual(['title'])
  })

  it('promotes a heading whose parent level is filtered out', () => {
    const toc = buildToc([{ depth: 3, text: 'Orphan', id: 'orphan' }])
    expect(toc).toHaveLength(1)
  })
})

describe('readingTime', () => {
  it('counts latin words', () => {
    const rt = readingTimeOf('one two three four five')
    expect(rt.words).toBe(5)
    expect(rt.minutes).toBe(1)
  })

  it('never reports zero minutes', () => {
    expect(readingTimeOf('a').minutes).toBe(1)
  })

  it('scales with word count', () => {
    expect(readingTimeOf('word '.repeat(600)).minutes).toBe(3)
  })

  it('counts CJK by character, since it has no spaces', () => {
    // Word-splitting would score this 1; velite weights CJK at 0.56.
    const rt = readingTimeOf('日本語のテキストです'.repeat(20))
    expect(rt.words).toBeGreaterThan(80)
  })

  it('handles apostrophes as one word', () => {
    expect(readingTimeOf("don't").words).toBe(1)
  })
})

describe('excerpt', () => {
  const long = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20)

  it('cuts on a word boundary, not mid-word', () => {
    const out = excerptOf(long, { length: 50 })
    expect(out.endsWith('\u2026')).toBe(true)
    // velite slices at a byte offset and routinely splits a word
    expect(out.slice(0, -1)).toMatch(/[\p{L}\p{N}]$/u)
  })

  it('returns short text unchanged', () => {
    expect(excerptOf('short')).toBe('short')
  })
})

describe('excerpt marker', () => {
  const marked = markdown()
  const body = 'Intro with **bold** and `code`.\n\n<!--more-->\n\nThe hidden part.'

  it('renders the prefix rather than returning raw markdown', async () => {
    // Stripping tags off a source string leaves `**bold**` and backticks
    // behind; the prefix has to go through the renderer.
    expect(await ctx(body, marked).excerpt()).toBe('Intro with bold and code.')
  })

  it('can disable the marker and fall back to truncation', async () => {
    const out = await ctx(body, marked).excerpt({ separator: false })
    expect(out).toContain('hidden part')
  })

  it('works without a renderer, degrading to source stripping', async () => {
    expect(await ctx(body).excerpt()).toContain('Intro with')
  })
})

// ── the M3 gate ──────────────────────────────────────────────────────────────
const RENDERERS = [
  { name: 'marked', renderer: markdown() },
  { name: 'unified', renderer: unifiedRenderer() }
] as const

const SOURCE = [
  '# Title',
  '',
  'Intro paragraph with **bold** and `code`.',
  '',
  '## Section One',
  '',
  '- alpha',
  '- beta',
  '',
  '## Section Two',
  '',
  '### Nested',
  '',
  '> a quote',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |'
].join('\n')

describe('renderer conformance', () => {
  for (const { name, renderer } of RENDERERS) {
    describe(name, () => {
      it('renders block structure', async () => {
        const html = await ctx(SOURCE, renderer).markdown()
        expect(html).toContain('<h1')
        expect(html).toContain('<h2')
        expect(html).toContain('<strong>bold</strong>')
        expect(html).toContain('<code>code</code>')
        expect(html).toContain('<li>')
        expect(html).toContain('<blockquote>')
        // GFM is on by default in both
        expect(html).toContain('<table>')
      })

      it('gives every heading an id', async () => {
        const html = await ctx(SOURCE, renderer).markdown()
        expect(html).toMatch(/<h1[^>]*id="title"/)
        expect(html).toMatch(/<h2[^>]*id="section-one"/)
      })

      it('produces the same plain text', async () => {
        const plain = await ctx(SOURCE, renderer).plain()
        expect(plain).toContain('Intro paragraph with bold and code.')
        expect(plain).not.toContain('<')
      })

      it('produces the same table of contents', async () => {
        const toc = await ctx(SOURCE, renderer).toc()
        expect(toc.map(e => e.id)).toEqual(['section-one', 'section-two'])
        expect(toc[1]!.children.map(e => e.id)).toEqual(['nested'])
      })

      it('computes reading time from rendered text', async () => {
        const rt = await ctx(SOURCE, renderer).readingTime()
        expect(rt.words).toBeGreaterThan(10)
        expect(rt.minutes).toBe(1)
      })

      it('memoises: one render regardless of how many derivations are used', async () => {
        let calls = 0
        const counting = {
          name: 'counting',
          toHtml(input: { body: string }) {
            calls++
            return `<h2>H</h2><p>${input.body}</p>`
          }
        }
        const c = ctx('body text', counting)
        await Promise.all([c.markdown(), c.plain(), c.excerpt(), c.toc(), c.readingTime()])
        expect(calls).toBe(1)
      })
    })
  }

  it('agrees on plain text across renderers', async () => {
    const [a, b] = await Promise.all(RENDERERS.map(r => ctx(SOURCE, r.renderer).plain()))
    expect(a).toBe(b)
  })

  it('agrees on the table of contents across renderers', async () => {
    const [a, b] = await Promise.all(RENDERERS.map(r => ctx(SOURCE, r.renderer).toc()))
    expect(a).toEqual(b)
  })

  it('agrees on reading time across renderers', async () => {
    const [a, b] = await Promise.all(RENDERERS.map(r => ctx(SOURCE, r.renderer).readingTime()))
    expect(a).toEqual(b)
  })
})

describe('code is not mistaken for content', () => {
  const marked = markdown()
  const source = [
    '# Real Heading',
    '',
    '```md',
    '# Phantom One',
    '## Phantom Two',
    '```',
    '',
    '    # Indented Phantom',
    '',
    '## Second Real'
  ].join('\n')

  it('never lists a heading the HTML did not emit', async () => {
    // A phantom entry points the TOC at an anchor that does not exist.
    const toc = await ctx(source, marked).toc({ minDepth: 1, maxDepth: 6 })
    const ids = toc.flatMap(e => [e.id, ...e.children.map(c => c.id)])
    expect(ids).toEqual(['real-heading', 'second-real'])
  })

  it('agrees with the rendered anchors', async () => {
    const c = ctx(source, marked)
    const html = await c.markdown()
    const toc = await c.toc({ minDepth: 1, maxDepth: 6 })
    for (const entry of toc) expect(html).toContain(`id="${entry.id}"`)
  })

  it('closes a fence only on a delimiter at least as long', async () => {
    const nested = ['````md', '```', '# Still Code', '```', '````', '', '# Real'].join('\n')
    const toc = await ctx(nested, marked).toc({ minDepth: 1, maxDepth: 6 })
    expect(toc.map(e => e.id)).toEqual(['real'])
  })
})

describe('no renderer configured', () => {
  it('fails markdown() with an actionable message', async () => {
    await expect(ctx('x').markdown()).rejects.toThrow(MissingRendererError)
    await expect(ctx('x').markdown()).rejects.toThrow(/No renderer configured/)
  })

  it('still derives reading time from the raw body', async () => {
    // Plain-text sources stay useful without a renderer.
    const rt = await ctx('one two three').readingTime()
    expect(rt.words).toBe(3)
  })
})

describe('transform context isolation', () => {
  fixtureTest('never serves one document’s render to another', async ({ fixture }) => {
    // The memo lives in a per-document closure. If it ever escaped to module
    // scope, every document after the first would silently show the first
    // one's HTML — a wrong answer with no error anywhere, on the single most
    // used method in the API.
    await fixture.write(
      'contentmap.config.ts',
      `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}
import { markdown } from ${JSON.stringify(MARKDOWN)}
import { z } from 'zod'
const posts = defineCollection({
  name: 'posts', directory: 'content', include: '**/*.md',
  schema: z.object({ title: z.string(), content: z.string() }),
  transform: async (doc, ctx) => ({ ...doc, html: await ctx.markdown(), words: (await ctx.readingTime()).words })
})
export default defineConfig({ renderer: markdown(), collections: { posts } })
`
    )
    await fixture.write('content/a.md', '---\ntitle: A\n---\n\nAlpha body alpha.')
    await fixture.write('content/b.md', '---\ntitle: B\n---\n\nBeta body beta beta beta.')

    const result = await createBuilder({ root: fixture.dir, concurrency: 8 }).build()
    expect(result.errors, JSON.stringify(result.diagnostics.map(d => d.message))).toBe(0)

    const a = await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')
    const b = await readFile(join(fixture.dir, '.contentmap/posts/b.js'), 'utf8')

    expect(a).toContain('Alpha body alpha')
    expect(a).not.toContain('Beta body')
    expect(b).toContain('Beta body beta')
    expect(b).not.toContain('Alpha body')
  })

  fixtureTest('renders once however many derivations ask for it', async ({ fixture }) => {
    // markdown(), plain(), excerpt(), toc() and readingTime() all need the
    // rendered document. Rendering per call would multiply the cost of the
    // most expensive step in the pipeline by five.
    await fixture.write(
      'contentmap.config.ts',
      `import { defineConfig, defineCollection, defineParser } from ${JSON.stringify(SRC)}
import { z } from 'zod'
let renders = 0
const counting = {
  name: 'counting',
  toHtml: (input) => { renders++; return '<p>' + input.body + '</p>' }
}
const posts = defineCollection({
  name: 'posts', directory: 'content', include: '**/*.md',
  schema: z.object({ title: z.string(), content: z.string() }),
  transform: async (doc, ctx) => {
    await ctx.markdown()
    await ctx.plain()
    await ctx.excerpt()
    await ctx.toc()
    await ctx.readingTime()
    await ctx.markdown()
    return { ...doc, renders }
  }
})
export default defineConfig({ renderer: counting, collections: { posts } })
`
    )
    await fixture.write('content/a.md', '---\ntitle: A\n---\n\n## Heading\n\nSome body text here.')

    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors, JSON.stringify(result.diagnostics.map(d => d.message))).toBe(0)

    const emitted = await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')
    expect(emitted).toContain('renders: 1')
  })
})
