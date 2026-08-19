import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBuilder } from '../src/builder.ts'
import { dotPath, validate } from '../src/validate/standard.ts'
import { fixtureTest } from './helpers.ts'

const SRC = pathToFileURL(resolve(import.meta.dirname, '../src/index.ts')).href

/**
 * Every Standard Schema vendor must produce the same diagnostic structure.
 *
 * content-collections renders `- [object Object]:` for every valibot issue,
 * because the spec allows a path segment to be either a PropertyKey or a
 * `{ key }` object and it interpolates the raw array. A tool that claims to be
 * validator-agnostic has to prove it on more than zod.
 */
const VENDORS = [
  {
    name: 'zod',
    imports: `import { z } from 'zod'`,
    schema: `z.object({ title: z.string(), nested: z.object({ deep: z.string() }) })`
  },
  {
    name: 'valibot',
    imports: `import * as v from 'valibot'`,
    schema: `v.object({ title: v.string(), nested: v.object({ deep: v.string() }) })`
  },
  {
    name: 'arktype',
    // arktype's Type is CALLABLE, which a `typeof === "object"` guard rejects.
    imports: `import { type } from 'arktype'`,
    schema: `type({ title: 'string', nested: { deep: 'string' } })`
  },
  {
    name: 'effect',
    imports: `import { Schema } from 'effect'`,
    schema:
      `Schema.standardSchemaV1(Schema.Struct({ title: Schema.String, nested: Schema.Struct({ deep: Schema.String }) }))`
  }
] as const

describe('standard schema vendors', () => {
  for (const vendor of VENDORS) {
    fixtureTest(`${vendor.name}: reports field paths identically`, async ({ fixture }) => {
      await fixture.write(
        'contentmap.config.ts',
        `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}\n` +
          `${vendor.imports}\n` +
          `const posts = defineCollection({\n` +
          `  name: 'posts', directory: 'content', include: '**/*.md',\n` +
          `  schema: ${vendor.schema}\n` +
          `})\n` +
          `export default defineConfig({ collections: { posts } })\n`
      )
      await fixture.write('content/bad.md', '---\ntitle: 5\nnested:\n  deep: 6\n---\nx')

      const result = await createBuilder({ root: fixture.dir }).build()
      const fields = result.diagnostics
        .filter(d => d.code === 'CM_VALIDATION')
        .map(d => d.field)
        .sort()

      expect(fields, `${vendor.name} produced: ${JSON.stringify(fields)}`).toEqual([
        'nested.deep',
        'title'
      ])

      for (const d of result.diagnostics.filter(x => x.code === 'CM_VALIDATION')) {
        // no "[object Object]", no comma-joined paths, always a real message
        expect(d.field).not.toContain('[object')
        expect(d.field).not.toContain(',')
        expect(d.message.length).toBeGreaterThan(0)
        expect(d.file).toBe('bad.md')
      }
    })
  }

  it('renders both spec path-segment forms', () => {
    // PropertyKey form (zod, arktype) and { key } object form (valibot)
    expect(dotPath(['nested', 'deep'])).toBe('nested.deep')
    expect(dotPath([{ key: 'nested' }, { key: 'deep' }])).toBe('nested.deep')
    expect(dotPath(['list', 0, 'a'])).toBe('list[0].a')
    expect(dotPath([{ key: 'list' }, { key: 0 }, { key: 'a' }])).toBe('list[0].a')
  })

  it('takes the synchronous fast path when a vendor is sync', async () => {
    const sync = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (value: unknown) => ({ value: value as Record<string, unknown> })
      }
    }
    const promise = sync['~standard'].validate({ a: 1 })
    expect(promise).not.toBeInstanceOf(Promise)
    await expect(validate(sync, { a: 1 })).resolves.toEqual({ ok: true, value: { a: 1 } })
  })
})
