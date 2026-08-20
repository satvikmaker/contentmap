import { describe, expect, it } from 'vitest'
import { mapLimit } from '../src/utils/limit.ts'
import { stableStringify } from '../src/utils/digest.ts'
import { idFromPath, isIdentifier, suggest } from '../src/utils/paths.ts'
import { splitFrontmatter, parseFrontmatterBlock } from '../src/parsers/frontmatter.ts'
import { serialize, SerializeError, moduleNameFor } from '../src/write/serialize.ts'
import { dotPath } from '../src/validate/standard.ts'
import { collection } from '../src/runtime/index.ts'

describe('mapLimit', () => {
  it('preserves input order', async () => {
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async n => {
      await new Promise(r => setTimeout(r, n))
      return n * 10
    })
    expect(out).toEqual([50, 10, 40, 20, 30])
  })

  it('never exceeds the concurrency limit', async () => {
    let live = 0
    let peak = 0
    await mapLimit(
      Array.from({ length: 50 }, (_, i) => i),
      4,
      async () => {
        peak = Math.max(peak, ++live)
        await new Promise(r => setTimeout(r, 1))
        live--
        return null
      }
    )
    expect(peak).toBeLessThanOrEqual(4)
  })

  it('propagates the first rejection without unhandled rejections', async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async n => {
        if (n === 2) throw new Error('boom')
        return n
      })
    ).rejects.toThrow('boom')
  })

  it('handles an empty input', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([])
  })
})

describe('stableStringify', () => {
  it('is insensitive to key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 2 }, b: 1 })
    )
  })
  it('preserves array order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]')
  })
})

describe('paths', () => {
  it('derives ids, stripping extension and trailing /index', () => {
    expect(idFromPath('posts/hello.md')).toBe('posts/hello')
    expect(idFromPath('posts/intro/index.md')).toBe('posts/intro')
    expect(idFromPath('index.md')).toBe('')
  })
  it('validates identifiers', () => {
    expect(isIdentifier('posts')).toBe(true)
    expect(isIdentifier('my-posts')).toBe(false)
    expect(isIdentifier('1posts')).toBe(false)
  })
  it('suggests near misses only', () => {
    expect(suggest('catgeory', ['category', 'title'])).toBe('category')
    expect(suggest('zzzzzzzz', ['category', 'title'])).toBeUndefined()
  })
})

describe('frontmatter', () => {
  it('splits YAML frontmatter', () => {
    const r = splitFrontmatter('---\ntitle: Hi\n---\nBody')
    expect(r.format).toBe('yaml')
    expect(r.raw).toBe('title: Hi')
    expect(r.body).toBe('Body')
  })

  it('splits TOML and JSON frontmatter', () => {
    expect(splitFrontmatter('+++\ntitle = "Hi"\n+++\nB').format).toBe('toml')
    expect(splitFrontmatter(';;;\n{"title":"Hi"}\n;;;\nB').format).toBe('json')
  })

  it('handles a document with no frontmatter', () => {
    const r = splitFrontmatter('# Just a body')
    expect(r.raw).toBeNull()
    expect(r.body).toBe('# Just a body')
  })

  it('strips a BOM', () => {
    expect(splitFrontmatter('﻿---\na: 1\n---\nB').raw).toBe('a: 1')
  })

  it('handles CRLF line endings', () => {
    expect(splitFrontmatter('---\r\ntitle: Hi\r\n---\r\nBody').raw).toBe('title: Hi')
  })

  // The reason we do not use gray-matter: it pins js-yaml@3 (YAML 1.1), where
  // 01234 parses as octal 668, 12:30 as sexagesimal 750, and NO as false.
  it('does not corrupt YAML 1.1 ambiguities', () => {
    const data = parseFrontmatterBlock('zip: "01234"\ntime: "12:30"\ncountry: "NO"', 'yaml')
    expect(data['zip']).toBe('01234')
    expect(data['time']).toBe('12:30')
    expect(data['country']).toBe('NO')
  })

  it('rejects non-mapping frontmatter', () => {
    expect(() => parseFrontmatterBlock('- a\n- b', 'yaml')).toThrow(/must be a mapping/)
  })
})

describe('serialize', () => {
  it('round-trips rich types', () => {
    const code = serialize({
      d: new Date('2026-01-01T00:00:00.000Z'),
      m: new Map([['a', 1]]),
      s: new Set([1, 2]),
      b: 10n,
      r: /ab+c/gi,
      u: undefined,
      n: null
    })
    const value = eval(`(${code})`) as Record<string, unknown>
    expect(value['d']).toBeInstanceOf(Date)
    expect(value['m']).toBeInstanceOf(Map)
    expect(value['s']).toBeInstanceOf(Set)
    expect(value['b']).toBe(10n)
    expect(value['r']).toBeInstanceOf(RegExp)
    expect(value['n']).toBeNull()
  })

  it('quotes keys that are not identifiers', () => {
    expect(serialize({ 'a-b': 1 })).toContain('"a-b"')
  })

  it('rejects functions and class instances with a path', () => {
    expect(() => serialize({ a: { b: () => 1 } })).toThrow(SerializeError)
    class Thing {}
    expect(() => serialize({ t: new Thing() })).toThrow(/Class instances/)
  })

  it('detects cycles', () => {
    const a: Record<string, unknown> = {}
    a['self'] = a
    expect(() => serialize(a)).toThrow(/Circular/)
  })

  it('makes safe module names', () => {
    expect(moduleNameFor('a/b')).toBe('a__b')
    expect(moduleNameFor('2024/post')).toBe('_2024__post')
  })
})

describe('dotPath', () => {
  it('renders nested and indexed paths', () => {
    expect(dotPath(['nested', 'deep'])).toBe('nested.deep')
    expect(dotPath(['list', 0, 'a'])).toBe('list[0].a')
  })
  // content-collections interpolates the raw array here, printing
  // "[object Object]" for every valibot issue.
  it('handles the PathSegment object form', () => {
    expect(dotPath([{ key: 'a' }, { key: 0 }, { key: 'b' }])).toBe('a[0].b')
  })
  it('returns undefined for empty or symbol paths', () => {
    expect(dotPath([])).toBeUndefined()
    expect(dotPath(undefined)).toBeUndefined()
    expect(dotPath([Symbol('x')])).toBeUndefined()
  })
})

describe('runtime Query', () => {
  const rows = [
    { _meta: { id: 'a' }, title: 'Alpha', n: 2 },
    { _meta: { id: 'b' }, title: 'Beta', n: 1 },
    { _meta: { id: 'c' }, title: 'Gamma', n: 3 }
  ]
  const withModules = () =>
    collection<Record<string, unknown>>(rows, {
      a: async () => ({ default: { ...rows[0], body: 'A body' } })
    })

  it('narrows projections and keeps _meta for identity', () => {
    const projected = withModules().select('title').all()[0]!
    expect(Object.keys(projected).sort()).toEqual(['_meta', 'title'])
  })

  it('chains where/sortBy/limit/skip without mutating the source', () => {
    const q = withModules()
    expect(q.where({ n: 1 }).count()).toBe(1)
    expect(
      q
        .sortBy('n')
        .all()
        .map(r => r['title'])
    ).toEqual(['Beta', 'Alpha', 'Gamma'])
    expect(q.sortBy('n', 'desc').first()?.['title']).toBe('Gamma')
    expect(q.limit(2).count()).toBe(2)
    expect(q.skip(2).ids()).toEqual(['c'])
    // the original query is untouched
    expect(q.count()).toBe(3)
  })

  it('sorts null and undefined last', () => {
    const q = collection<Record<string, unknown>>(
      [
        { _meta: { id: 'a' }, n: 2 },
        { _meta: { id: 'b' }, n: null },
        { _meta: { id: 'c' }, n: 1 }
      ],
      {}
    )
    expect(q.sortBy('n').ids()).toEqual(['c', 'a', 'b'])
  })

  it('sorts by a field that was not selected', () => {
    // select() records a projection and applies it once, at the terminal call,
    // so the rows still carry every index field while sorting. "Give me title
    // and slug, newest first" is the ordinary way to ask.
    const ordered = withModules().select('title').sortBy('n', 'desc').all()

    expect(ordered.map(r => r['title'])).toEqual(['Gamma', 'Alpha', 'Beta'])
    // The projection still applied. `_meta` always survives it, because ids()
    // and load() are reachable from any projected query.
    expect(Object.keys(ordered[0] ?? {}).sort()).toEqual(['_meta', 'title'])
  })

  it('groups by a field that was not selected', () => {
    // Reading the group key after projection put every row into a single
    // `undefined` group — a wrong answer rather than an error.
    const groups = withModules().select('title').groupBy('n')

    expect([...groups.keys()].sort()).toEqual([1, 2, 3])
    expect(
      [...groups.values()].every(rows => 'title' in (rows[0] ?? {}) && !('n' in (rows[0] ?? {})))
    ).toBe(true)
  })

  it('filters on a field that was not selected', () => {
    const found = withModules().select('title').where({ n: 1 }).all()

    expect(found.map(r => r['title'])).toEqual(['Beta'])
    expect(found.every(r => !('n' in r))).toBe(true)
  })

  it('groups by a field', () => {
    const groups = withModules().groupBy('n')
    expect(groups.size).toBe(3)
  })

  it('loads via a module when one exists', async () => {
    expect((await withModules().load('a'))['body']).toBe('A body')
  })

  // bundle output inlines documents and emits no modules
  it('falls back to the inlined row when there is no module', async () => {
    const bundled = collection<Record<string, unknown>>(rows, {})
    expect((await bundled.load('b'))['title']).toBe('Beta')
  })

  it('throws a named error for an unknown id', async () => {
    await expect(withModules().load('nope')).rejects.toThrow(/no document with id "nope"/)
  })

  it('survives projection before load', async () => {
    const q = withModules().select('title')
    expect(q.ids()).toEqual(['a', 'b', 'c'])
    expect((await q.load('a'))['body']).toBe('A body')
  })
})
