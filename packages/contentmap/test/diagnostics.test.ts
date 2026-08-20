import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBuilder } from '../src/builder.ts'
import { DiagnosticBag, renderDiagnostics } from '../src/diagnostics/index.ts'
import { codeFrame, findKeyPosition, normalizeParserError } from '../src/diagnostics/frame.ts'
import { fixtureTest } from './helpers.ts'

const SRC = pathToFileURL(resolve(import.meta.dirname, '../src/index.ts')).href

describe('code frames', () => {
  const source = 'one\ntwo\nthree\nfour\nfive\nsix\nseven'

  it('marks the target line and points a caret at the column', () => {
    const frame = codeFrame(source, { line: 4, column: 2 })
    expect(frame).toContain('> 4 | four')
    expect(frame).toContain('^')
    // two lines of context either side
    expect(frame).toContain('2 | two')
    expect(frame).toContain('6 | six')
    expect(frame).not.toContain('seven')
  })

  it('clamps to the file bounds', () => {
    expect(codeFrame(source, { line: 1 })).toContain('> 1 | one')
    expect(codeFrame(source, { line: 999 })).toContain('> 7 | seven')
  })

  it('truncates very long lines', () => {
    const long = 'x'.repeat(500)
    expect(codeFrame(long, { line: 1 }, 40).length).toBeLessThan(120)
  })
})

describe('findKeyPosition', () => {
  const source = '---\ntitle: Hi\n  nested:\n    deep: 1\n---\nbody'

  it('locates a top-level key', () => {
    expect(findKeyPosition(source, 'title')).toEqual({ line: 2, column: 1 })
  })

  it('locates the root of a nested path', () => {
    expect(findKeyPosition(source, 'nested.deep')).toEqual({ line: 3, column: 3 })
  })

  it('locates the root of an indexed path', () => {
    expect(findKeyPosition('---\nlist:\n  - a: 1\n---', 'list[0].a')).toEqual({
      line: 2,
      column: 1
    })
  })

  it('returns undefined for a key that is absent', () => {
    expect(findKeyPosition(source, 'missing')).toBeUndefined()
  })

  it('never points at prose that merely looks like a key', () => {
    // Scanning the whole file drew the caret onto a code sample in the body.
    const doc = ['---', 'author: a', '---', '', 'title: only in the body'].join('\n')
    expect(findKeyPosition(doc, 'title')).toBeUndefined()
  })

  it('stops at the closing delimiter', () => {
    const doc = ['---', 'a: 1', '---', 'b: 2'].join('\n')
    expect(findKeyPosition(doc, 'b')).toBeUndefined()
  })

  it('returns undefined when there is no frontmatter at all', () => {
    expect(findKeyPosition('title: not frontmatter', 'title')).toBeUndefined()
  })

  it('is not fooled by a substring key', () => {
    expect(findKeyPosition('---\nsubtitle: x\ntitle: y\n---', 'title')).toEqual({
      line: 3,
      column: 1
    })
  })
})

describe('normalizeParserError', () => {
  it('prefers an explicit file-relative position', () => {
    const err = Object.assign(new Error('boom (2:3)'), { line: 9, column: 4 })
    expect(normalizeParserError(err)).toEqual({ message: 'boom', position: { line: 9, column: 4 } })
  })

  it('extracts a trailing (line:column) and strips it from the message', () => {
    expect(normalizeParserError(new Error('bad thing (12:5)'))).toEqual({
      message: 'bad thing',
      position: { line: 12, column: 5 }
    })
  })

  it('keeps only the first line, dropping an embedded frame', () => {
    // js-yaml appends its own ASCII frame; left in place it breaks our layout
    // and makes --json messages multi-line.
    const raw = 'bad indentation (2:6)\n\n 1 | a\n 2 |   b\n------^'
    expect(normalizeParserError(new Error(raw)).message).toBe('bad indentation')
  })

  it('survives an error with no position at all', () => {
    expect(normalizeParserError(new Error('plain'))).toEqual({
      message: 'plain',
      position: undefined
    })
  })
})

describe('DiagnosticBag', () => {
  const d = (over: Partial<Parameters<DiagnosticBag['add']>[0]> = {}) => ({
    code: 'CM_VALIDATION' as const,
    severity: 'error' as const,
    message: 'boom',
    ...over
  })

  it('deduplicates identical diagnostics', () => {
    const bag = new DiagnosticBag()
    bag.add(d({ file: 'a.md', field: 'title' }))
    bag.add(d({ file: 'a.md', field: 'title' }))
    expect(bag.size).toBe(1)
  })

  it('keeps diagnostics that differ by field', () => {
    const bag = new DiagnosticBag()
    bag.add(d({ file: 'a.md', field: 'title' }))
    bag.add(d({ file: 'a.md', field: 'date' }))
    expect(bag.size).toBe(2)
  })

  it('orders errors before warnings, then by file and line', () => {
    const bag = new DiagnosticBag()
    bag.add(d({ severity: 'warning', file: 'a.md' }))
    bag.add(d({ file: 'b.md', line: 5 }))
    bag.add(d({ file: 'b.md', line: 2 }))
    const order = bag.sorted().map(x => `${x.severity}:${x.file}:${x.line ?? 0}`)
    expect(order).toEqual(['error:b.md:2', 'error:b.md:5', 'warning:a.md:0'])
  })

  it('counts the corpus, not the survivors', () => {
    const bag = new DiagnosticBag()
    bag.add(d({ file: 'a.md' }))
    const out = renderDiagnostics(bag, { total: 100 })
    expect(out).toContain('in 100 documents')
    expect(out).toContain('(99 ok)')
  })

  it('collapses long groups instead of flooding the terminal', () => {
    const bag = new DiagnosticBag()
    for (let i = 0; i < 25; i++) bag.add(d({ file: `f${i}.md` }))
    const out = renderDiagnostics(bag, { total: 25, limit: 5 })
    expect(out).toContain('and 20 more file(s)')
  })
})

// ── the M2 gate ──────────────────────────────────────────────────────────────
const config = (body: string): string =>
  `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}\n` +
  `import { z } from 'zod'\n\n${body}\n`

const SCHEMA = `z.object({
    title: z.string().max(20),
    date: z.coerce.date().optional(),
    nested: z.object({ deep: z.string() }).optional(),
    list: z.array(z.object({ a: z.string() })).optional(),
    content: z.string().optional()
  })`

describe('defect corpus', () => {
  fixtureTest(
    'reports twelve distinct defect classes, each naming its file',
    async ({ fixture }) => {
      await fixture.write(
        'contentmap.config.ts',
        config(`
const posts = defineCollection({
  name: 'posts', directory: 'content', include: '**/*.{md,yaml,json}',
  schema: ${SCHEMA}
})
export default defineConfig({ collections: { posts } })`)
      )

      // 1 wrong scalar type
      await fixture.write('content/01-type.md', '---\ntitle: [an, array]\n---\nx')
      // 2 too long
      await fixture.write(
        'content/02-long.md',
        '---\ntitle: way way way too long for this schema\n---\nx'
      )
      // 3 nested field
      await fixture.write('content/03-nested.md', '---\ntitle: N\nnested:\n  deep: 5\n---\nx')
      // 4 array element
      await fixture.write('content/04-list.md', '---\ntitle: L\nlist:\n  - a: 1\n---\nx')
      // 5 bad date
      await fixture.write('content/05-date.md', '---\ntitle: D\ndate: not-a-date\n---\nx')
      // 6 malformed YAML
      await fixture.write('content/06-yaml.md', '---\ntitle: Y\n  bad: [indent\n---\nx')
      // 7 frontmatter that is not a mapping
      await fixture.write('content/07-seq.md', '---\n- a\n- b\n---\nx')
      // 8 root-level array in yaml
      await fixture.write('content/08-root.yaml', '- not\n- objects')
      // 9 malformed JSON
      await fixture.write('content/09-bad.json', '{ "title": ')
      // 10 unknown field
      await fixture.write('content/10-unknown.md', '---\ntitle: U\ncatgeory: news\n---\nx')
      // 11 + 12 duplicate id from a flat file and an index file
      await fixture.write('content/dupe.md', '---\ntitle: A\n---\nx')
      await fixture.write('content/dupe/index.md', '---\ntitle: B\n---\nx')

      const result = await createBuilder({ root: fixture.dir, onValidationError: 'skip' }).build()

      const codes = new Set(result.diagnostics.map(d => d.code))
      expect(codes).toContain('CM_VALIDATION')
      expect(codes).toContain('CM_PARSE')
      expect(codes).toContain('CM_UNKNOWN_FIELD')
      expect(codes).toContain('CM_DUPLICATE_ID')

      // Every diagnostic must name a file. A message with no location is the
      // failure mode that makes a large corpus unsearchable.
      for (const d of result.diagnostics) {
        expect(d.file ?? d.documentId, `${d.code}: ${d.message}`).toBeDefined()
      }

      // Field-level diagnostics carry a resolvable position.
      const located = result.diagnostics.filter(d => d.line !== undefined)
      expect(located.length).toBeGreaterThanOrEqual(6)
      for (const d of located) expect(d.frame).toBeDefined()

      const bag = new DiagnosticBag()
      for (const d of result.diagnostics) bag.add(d)
      const report = renderDiagnostics(bag, { total: result.scanned })
      expect(report).toContain('Validation')
      expect(report).toContain('Parse')
      expect(report).toContain('Unknown field')
      expect(report).toContain('Duplicate id')
    }
  )
})
