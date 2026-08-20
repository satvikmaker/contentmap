import { describe, expect, it } from 'vitest'
import { migrate } from '../src/index.ts'

// A config in the shape contentlayer's own documentation uses.
const CONTENTLAYER = `
import { defineDocumentType, makeSource } from 'contentlayer2/source-files'

export const Post = defineDocumentType(() => ({
  name: 'Post',
  filePathPattern: 'posts/**/*.md',
  contentType: 'markdown',
  fields: {
    title: { type: 'string', required: true },
    date: { type: 'date', required: true },
    draft: { type: 'boolean', default: false },
    tags: { type: 'list', of: { type: 'string' } },
    status: { type: 'enum', options: ['draft', 'published'], required: true },
    cover: { type: 'image' },
    author: { type: 'reference', of: Author }
  },
  computedFields: {
    slug: { type: 'string', resolve: doc => doc._raw.flattenedPath },
    readingTime: { type: 'number', resolve: doc => doc.body.raw.split(' ').length / 200 }
  }
}))

export default makeSource({ contentDirPath: 'content', documentTypes: [Post] })
`

const VELITE = `
import { defineConfig, defineCollection, s } from 'velite'

const posts = defineCollection({
  name: 'Post',
  pattern: 'posts/**/*.md',
  schema: s.object({
    title: s.string().max(99),
    slug: s.slug('posts'),
    date: s.isodate(),
    cover: s.image(),
    body: s.markdown(),
    metadata: s.metadata()
  })
})

export default defineConfig({ root: 'content', collections: { posts } })
`

const CONTENT_COLLECTIONS = `
import { defineCollection, defineConfig } from '@content-collections/core'
import { z } from 'zod'

const posts = defineCollection({
  name: 'posts',
  directory: 'content/posts',
  include: '**/*.md',
  schema: z.object({ title: z.string(), date: z.coerce.date() }),
  transform: async (doc, ctx) => ({ ...doc, slug: doc._meta.path })
})

export default defineConfig({ collections: [posts] })
`

describe('contentlayer2', () => {
  const result = migrate(CONTENTLAYER, 'contentlayer2')

  it('turns a document type into a collection', () => {
    // contentlayer names types in the singular and exports the plural.
    expect(result.collections).toEqual(['posts'])
    expect(result.config).toContain("name: 'posts'")
    expect(result.config).toContain("typeName: 'Post'")
    expect(result.config).toContain("directory: 'content'")
    expect(result.config).toContain("include: 'posts/**/*.md'")
  })

  it('rebuilds the field DSL as zod, which is the tedious part', () => {
    expect(result.config).toContain('title: z.string(),')
    expect(result.config).toContain('date: z.coerce.date(),')
    // `required` is absent, so it is optional; a default implies presence.
    expect(result.config).toContain('draft: z.boolean().default(false),')
    expect(result.config).toContain('tags: z.array(z.string()).optional(),')
    expect(result.config).toContain("status: z.enum(['draft', 'published']),")
  })

  it('injects the body field contentlayer supplied implicitly', () => {
    expect(result.config).toContain('content: z.string(),')
    expect(result.notes.some(n => n.subject === 'body')).toBe(true)
  })

  it('rewrites computed fields onto the contentmap context', () => {
    // `_raw` does not exist here, so leaving it would produce a config that
    // crashes on the first build — which looks like the tool half worked.
    // These are exact equivalents, which is what makes rewriting them safe.
    expect(result.config).toContain('slug: ctx.meta.path')
    expect(result.config).toContain('readingTime: ctx.body.split')
    expect(result.config).not.toContain('_raw')

    const slug = result.notes.find(n => n.subject === 'computedFields.slug')
    expect(slug?.kind).toBe('review')
    expect(slug?.message).toContain('_raw.flattenedPath -> ctx.meta.path')
  })

  it('preserves a resolver it cannot reduce, rather than dropping it', () => {
    const withBlock = migrate(
      CONTENTLAYER.replace(
        'resolve: doc => doc._raw.flattenedPath',
        'resolve: doc => { const p = doc._raw.flattenedPath; return p.toUpperCase() }'
      ),
      'contentlayer2'
    )
    // A block body needs a human. It is carried over verbatim and attributed.
    expect(withBlock.config).toContain('TODO(contentmap): from contentlayer computedFields.slug')
    expect(withBlock.config).toContain('p.toUpperCase()')
    expect(withBlock.notes.find(n => n.subject === 'computedFields.slug')?.kind).toBe('manual')
  })

  it('reports what it could not do rather than guessing', () => {
    const image = result.notes.find(n => n.subject === 'cover')
    expect(image?.kind).toBe('manual')
    expect(image?.hint).toContain('ctx.image')

    const reference = result.notes.find(n => n.subject === 'author')
    expect(reference?.kind).toBe('review')
    expect(reference?.hint).toContain('ctx.documents')
  })
})

describe('velite', () => {
  const result = migrate(VELITE, 'velite')

  it('maps pattern and root onto include and directory', () => {
    expect(result.collections).toEqual(['posts'])
    expect(result.config).toContain("directory: 'content'")
    expect(result.config).toContain("include: 'posts/**/*.md'")
    expect(result.config).toContain("typeName: 'Post'")
  })

  it('passes plain zod through, chained methods and all', () => {
    expect(result.config).toContain('title: z.string().max(99),')
  })

  it('translates the helpers that have a schema equivalent', () => {
    expect(result.config).toContain('date: z.coerce.date(),')
  })

  it('moves build-time helpers to the transform instead of faking a schema field', () => {
    const markdown = result.notes.find(n => n.subject.startsWith('body'))
    expect(markdown?.kind).toBe('manual')
    expect(markdown?.hint).toContain('ctx.markdown()')
    // s.markdown() reads the body, so it is not a frontmatter field.
    expect(result.config).not.toContain('body:')
    // But the body still has to be declared, or there is nothing to render.
    expect(result.config).toContain('content: z.string(),')

    const metadata = result.notes.find(n => n.subject.startsWith('metadata'))
    // contentmap has ctx.readingTime(), so claiming this is unsupported would
    // send people away from a feature that exists.
    expect(metadata?.kind).toBe('manual')
    expect(metadata?.hint).toContain('ctx.readingTime()')
  })

  it('keeps image fields in the schema, because frontmatter still holds a path', () => {
    // Dropping it would leave `cover` as unknown frontmatter and get it reported.
    expect(result.config).toContain('cover: z.string()')
    expect(result.notes.find(n => n.subject.startsWith('cover'))?.hint).toContain(
      '@contentmap/image'
    )
  })
})

describe('content-collections', () => {
  const result = migrate(CONTENT_COLLECTIONS, 'content-collections')

  it('lifts the schema rather than rebuilding it', () => {
    // Both tools take a Standard Schema, so reconstructing it could only lose detail.
    expect(result.config).toContain(
      'schema: z.object({ title: z.string(), date: z.coerce.date() })'
    )
  })

  it('turns the collections array into an object', () => {
    expect(result.collections).toEqual(['posts'])
    expect(result.config).toContain('collections: { posts }')
  })

  it('moves _meta from the document onto the context', () => {
    // Same field names, different owner: contentmap validates first and passes
    // only the schema's own output, so `doc._meta` would read as undefined.
    expect(result.config).toContain('slug: ctx.meta.path')
    expect(result.config).not.toContain('doc._meta')
    expect(result.notes.some(n => n.message.includes('`_meta` was moved'))).toBe(true)
  })

  it('gives the transform a ctx parameter when the rewrite starts needing one', () => {
    // These transforms are commonly written `(doc) => …` because the context is
    // rarely needed. Moving `_meta` onto the context makes it needed, and a
    // reference to an undeclared parameter is "ctx is not defined" on the first
    // build — invisible to a text comparison, immediate in a real one.
    for (const [head, expected] of [
      ['(doc) =>', '(doc, ctx) =>'],
      ['doc =>', '(doc, ctx) =>'],
      ['async (doc) =>', 'async (doc, ctx) =>']
    ]) {
      const out = migrate(
        CONTENT_COLLECTIONS.replace('transform: async (doc, ctx) =>', `transform: ${head}`),
        'content-collections'
      )
      expect(out.config, `for \`${head}\``).toContain(expected)
    }
  })

  it('leaves a transform alone when it already takes a context', () => {
    expect(result.config).toContain('async (doc, ctx) =>')
  })

  it('warns that the transform context is not the same object', () => {
    const note = result.notes.find(n => n.subject === 'transform' && n.kind === 'manual')
    expect(note?.hint).toContain('cache()')
  })
})

describe('every migration', () => {
  it('produces a config that parses as TypeScript', async () => {
    const ts = (await import('typescript')).default
    for (const [source, tool] of [
      [CONTENTLAYER, 'contentlayer2'],
      [VELITE, 'velite'],
      [CONTENT_COLLECTIONS, 'content-collections']
    ] as const) {
      const { config } = migrate(source, tool)
      const parsed = ts.createSourceFile('out.ts', config, ts.ScriptTarget.Latest, true)
      const diagnostics = (parsed as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics
      expect(diagnostics ?? [], `${tool} produced unparseable output:\n${config}`).toHaveLength(0)
    }
  })

  it('always names contentmap and zod as required installs', () => {
    for (const tool of ['contentlayer2', 'velite', 'content-collections'] as const) {
      const { install } = migrate('export default {}', tool)
      expect(install).toContain('contentmap')
      expect(install).toContain('zod')
    }
  })
})
