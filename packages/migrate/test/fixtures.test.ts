import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { migrate, type MigrationResult, type Note, type SourceTool } from '../src/index.ts'

/**
 * One fixture per pattern real configs use.
 *
 * Written for this suite rather than copied from any project: each isolates one
 * thing a real config did that the codemod once got wrong, so a failure names
 * the pattern. `scripts/verify-migrate.mjs` builds every one of them for real
 * and compares the documents with the fixture's `expected.json`; these tests
 * pin the generated text and the report.
 */
const FIXTURES = resolve(import.meta.dirname, 'fixtures')

const CONFIG_FILES: [string, SourceTool][] = [
  ['contentlayer.config.ts', 'contentlayer2'],
  ['velite.config.ts', 'velite'],
  ['content-collections.ts', 'content-collections']
]

function fixture(name: string, outFile?: string): MigrationResult {
  for (const [file, tool] of CONFIG_FILES) {
    const path = join(FIXTURES, name, file)
    if (!existsSync(path)) continue
    return migrate(readFileSync(path, 'utf8'), tool, path, outFile === undefined ? {} : { outFile })
  }
  throw new Error(`fixture "${name}" has no config`)
}

const note = (result: MigrationResult, where: string): Note | undefined =>
  result.notes.find(n => (n.collection ? `${n.collection}.${n.subject}` : n.subject) === where)

describe('shared computed fields', () => {
  const result = fixture('shared-computed-fields')

  it('follows a spread into the computed fields it holds', () => {
    // The spread was skipped without a word: on the first real config this
    // codemod saw, five of six computed fields vanished.
    for (const field of ['slug', 'path', 'url']) {
      expect(note(result, `posts.computedFields.${field}`), field).toBeDefined()
    }
    expect(result.config).toContain("slug: ctx.meta.path.replace(/^.+?\\//, '')")
    expect(result.config).toContain('url: `/blog/${ctx.meta.path}`')
  })

  it('follows a shorthand to the const it names', () => {
    const pages = result.config.slice(result.config.indexOf('const pages'))
    expect(pages).toContain('slug: ctx.meta.path')
    expect(pages).toContain('path: ctx.meta.path')
  })

  it('inlines the shared object instead of carrying it, type and all', () => {
    expect(result.config).not.toContain('ComputedFields')
    expect(result.notes.filter(n => n.kind === 'manual')).toEqual([])
  })
})

describe('shared fields', () => {
  it('follows spreads, shorthands and named definitions', () => {
    const { config } = fixture('shared-fields')
    expect(config).toContain('title: z.string(),')
    expect(config).toContain('draft: z.boolean().default(false),')
    expect(config).toContain('summary: z.string().optional()')
  })
})

describe('carried code', () => {
  const result = fixture('carried-code')

  it('imports what the moved code uses, and only that', () => {
    expect(result.config).toContain("import { basename } from 'node:path'")
    expect(result.config).toContain("import * as nodePath from 'node:path'")
    expect(result.config).toContain("import countWords from './lib/words.mjs'")
    expect(result.config).toContain("import { SITE } from './lib/site.mjs'")
    expect(result.config).not.toContain('Unused')
    expect(result.config).not.toContain('unused')
  })

  it('carries the declarations it needs, with their comments', () => {
    // `base` needs `SITE`, which nothing in a resolver names directly.
    expect(result.config).toContain(
      '// Every link is built from this.\nconst base = `${SITE}/content`'
    )
    expect(result.config).toContain('function titleCase(input: string): string {')
  })

  it('re-points relative imports when the config is written somewhere else', () => {
    const elsewhere = join(FIXTURES, 'carried-code', 'config', 'contentmap.config.ts')
    const { config } = fixture('carried-code', elsewhere)
    expect(config).toContain("import countWords from '../lib/words.mjs'")
    expect(config).toContain("import { basename } from 'node:path'")
  })
})

describe('plurals', () => {
  it('names each collection the way contentlayer named its export', () => {
    // allAuthors, allPeople, allCategories, allSeries, allPosts.
    expect(fixture('plurals').collections).toEqual([
      'authors',
      'people',
      'categories',
      'series',
      'posts'
    ])
  })
})

describe('dates', () => {
  it('reports every field that turns from a string into a Date', () => {
    const result = fixture('dates')
    for (const field of ['date', 'updated', 'reminders[]']) {
      const found = note(result, `events.${field}`)
      expect(found?.message, field).toContain('`Date`')
      expect(found?.hint, field).toContain('z.coerce.date().transform(d => d.toISOString())')
    }
  })
})

describe('mdx', () => {
  const result = fixture('mdx')

  it('wires MDX up with the same plugins', () => {
    expect(result.config).toContain("import { mdx } from '@contentmap/mdx'")
    expect(result.config).toContain("import remarkShout from './lib/remark-shout.mjs'")
    expect(result.config).toContain("compat: 'mdx-bundler'")
    expect(result.config).toContain('remarkPlugins: [remarkShout]')
    expect(result.config).toContain("rehypePlugins: [[rehypeMark, { className: 'marked' }]]")
    expect(result.install).toContain('@contentmap/mdx')
  })

  it('rebuilds body.code, and rewrites a resolver that reads it', () => {
    expect(result.config).toContain('const body = { raw: ctx.body, code: await ctx.mdx() }')
    expect(result.config).toContain('compiled: body.code.length > 0')
  })

  it('says what it dropped', () => {
    expect(note(result, 'mdx.cwd')?.message).toBe('dropped')
    expect(result.config).not.toContain('process.cwd')
  })
})

describe('markdown', () => {
  it('renders with the pipeline contentlayer ran', () => {
    const result = fixture('markdown')
    expect(result.config).toContain("import { unifiedRenderer } from '@contentmap/unified'")
    expect(result.config).toContain('gfm: false')
    expect(result.config).toContain('headingIds: false')
    expect(result.config).toContain('remarkPlugins: [remarkShout]')
    expect(result.config).toContain('const body = { raw: ctx.body, html: await ctx.markdown() }')
    expect(result.install).toContain('@contentmap/unified')
  })
})

describe('resolver forms', () => {
  const result = fixture('resolver-forms')

  it('calls what it cannot inline, with the shape it was written for', () => {
    expect(result.config).toContain('const legacy = {')
    expect(result.config).toContain('named: await slugOf(legacy)')
    expect(result.config).toContain('method: await (function (doc) {')
    for (const field of ['block', 'method', 'named', 'destructured', 'whole']) {
      expect(note(result, `notes.computedFields.${field}`)?.message, field).toContain(
        'called as written'
      )
    }
  })

  it('inlines the rest, with exact rewrites', () => {
    expect(result.config).toContain("kind: 'Note'")
    expect(result.config).toContain('id: ctx.meta.filePath')
    expect(result.config).toContain('folder: ctx.meta.directory')
  })

  it('makes the transform async when an inlined resolver awaits', () => {
    // A data collection has no body to await, so nothing else would.
    expect(result.config).toContain('transform: async (doc, ctx) => {')
    expect(result.config).toContain('later: (await Promise.resolve(doc.title)).toLowerCase()')
  })

  it('carries the functions the called resolvers use', () => {
    expect(result.config).toContain('function slugOf(doc) {')
    expect(result.config).toContain('function describe(doc) {')
  })
})

describe('unfollowable', () => {
  const result = fixture('unfollowable')

  it('names everything it could not follow, instead of dropping it quietly', () => {
    const manual = result.notes
      .filter(n => n.kind === 'manual')
      .map(n => n.message)
      .join('\n')
    expect(manual).toContain('`...sharedFields`')
    expect(manual).toContain('`...makeComputed()`')
    expect(manual).toContain('[key]')
  })

  it('keeps everything it could follow', () => {
    expect(result.config).toContain('title: z.string()')
    expect(result.config).toContain('kept: doc.title')
  })
})

describe('nested types', () => {
  const result = fixture('nested-types')

  it('inlines nested types as objects', () => {
    expect(result.config).toContain('location: z.object({ lat: z.number(), lng: z.number() })')
    expect(result.config).toContain("tags: z.array(z.enum(['a', 'b'])).optional()")
    expect(result.config).toContain(
      'stops: z.array(z.object({ lat: z.number(), lng: z.number() })).optional()'
    )
  })

  it('tells the members of a mixed list apart by type, as contentlayer did', () => {
    expect(result.config).toContain("z.object({ type: z.literal('Image'), src: z.string() })")
    expect(result.config).toContain("z.object({ type: z.literal('Video'), url: z.string() })")
    expect(result.config).toContain('media: z.array(z.union([')
  })
})

describe('source options', () => {
  const result = fixture('options')

  it('translates the policies that have an equivalent', () => {
    expect(result.config).toContain("onValidationError: 'skip'")
    expect(result.config).toContain("onUnknownField: 'ignore'")
    expect(result.config).toContain("exclude: ['drafts', 'drafts/**']")
  })

  it('honours renamed body and type fields', () => {
    expect(result.config).toContain('article: body')
    expect(result.config).toContain("label: `${'Post'}:${body.raw.trim().length}`")
  })

  it('mentions every option it did not carry', () => {
    for (const subject of ['disableImportAliasWarning', 'date', 'somethingElse']) {
      expect(note(result, subject), subject).toBeDefined()
    }
  })
})

describe('velite spreads', () => {
  const result = fixture('velite-spreads')

  it('follows spreads among the collections and inside the schema', () => {
    expect(result.collections).toEqual(['posts', 'notes'])
    expect(result.config).toContain('tags: z.array(tag).optional()')
  })

  it('carries a shared schema fragment across as zod', () => {
    expect(result.config).toContain('const tag = z.string().max(20)')
    expect(result.config).not.toContain('velite')
  })
})

describe('content-collections spreads', () => {
  const result = fixture('content-collections-spreads')

  it('follows spreads in the collection list', () => {
    expect(result.collections).toEqual(['posts', 'pages'])
  })

  it('carries a shared schema and a helper, without importing zod twice', () => {
    expect(result.config).toContain('const base = z.object({ title: z.string() })')
    expect(result.config).toContain("import { wordCount } from './lib/words.mjs'")
    expect(result.config.match(/from 'zod'/g)).toHaveLength(1)
  })
})

describe('every fixture', () => {
  it.each(readdirSync(FIXTURES))('%s parses, and imports nothing from the old tool', name => {
    const { config } = fixture(name)
    const parsed = ts.createSourceFile('out.ts', config, ts.ScriptTarget.Latest, true)
    const diagnostics = (parsed as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics
    expect(diagnostics ?? [], config).toHaveLength(0)
    expect(config).not.toMatch(
      /from '(?:contentlayer2?|next-contentlayer2?|velite|@content-collections\/[^']+)(?:\/[^']*)?'/
    )
  })
})
