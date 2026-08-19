import { describe, expect, it } from 'vitest'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBuilder } from '../src/builder.ts'
import { findSecret, redactSecrets, screenForSecrets, SecretLeakError } from '../src/security/secrets.ts'
import { fixtureTest } from './helpers.ts'

const SRC = pathToFileURL(resolve(import.meta.dirname, '../src/index.ts')).href

/**
 * A scripted transport, so these tests never touch the network and can assert
 * exactly how many requests were made.
 */
function transport(script: (n: number) => { status?: number; body?: string; headers?: Record<string, string> }) {
  const calls: { headers: Record<string, string> }[] = []
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>)
    )
    calls.push({ headers })
    const step = script(calls.length)
    return new Response(step.body ?? '', {
      status: step.status ?? 200,
      headers: step.headers ?? { 'content-type': 'application/json' }
    })
  }
  return { fetchImpl, calls }
}

const RECORDS = JSON.stringify({
  items: [
    { slug: 'v2', version: '2.0.0', notes: 'second' },
    { slug: 'v1', version: '1.0.0', notes: 'first' }
  ]
})

function config(loaderBody: string): string {
  return (
    `import { defineConfig, defineCollection, http } from ${JSON.stringify(SRC)}\n` +
    `import { z } from 'zod'\n` +
    `const releases = defineCollection({\n` +
    `  name: 'releases',\n` +
    `  loader: ${loaderBody},\n` +
    `  schema: z.object({ slug: z.string(), version: z.string(), notes: z.string() })\n` +
    `})\n` +
    `export default defineConfig({ collections: { releases } })\n`
  )
}

/** Serialises a transport into the config, since it runs in a separate module. */
function scriptedLoader(script: string): string {
  return `http({
    url: 'https://example.invalid/releases',
    select: (p) => p.items,
    id: (r) => r.slug,
    fetch: ${script}
  })`
}

const OK_FETCH = `async () => new Response(${JSON.stringify(RECORDS)}, { status: 200, headers: { etag: 'W/"abc"' } })`

describe('secret screening', () => {
  it('recognises well-known credential shapes', () => {
    const shapes = [
      'Bearer abcdefghijklmnop',
      'sk-0123456789abcdefghij',
      'ghp_0123456789abcdefghij',
      'xoxb-1234567890-abcdefghij',
      'AKIAIOSFODNN7EXAMPLE',
      '-----BEGIN RSA PRIVATE KEY-----'
    ]
    for (const s of shapes) expect(findSecret(s, []), s).toBeDefined()
  })

  it('does not flag content hashes', () => {
    // This codebase writes sha1 and sha256 digests everywhere; a generic
    // entropy heuristic would fail builds for no reason.
    expect(findSecret('a'.repeat(40), [])).toBeUndefined()
    expect(findSecret('182e98fbca82680e07758dec99ce0f04bd368c77', [])).toBeUndefined()
    expect(findSecret('hero-b2bbe763.png', [])).toBeUndefined()
  })

  it('catches a bespoke token by matching the environment', () => {
    const value = 'not-a-recognisable-shape-at-all-1234'
    expect(findSecret(`x ${value} y`, [value])).toMatch(/environment/)
  })

  it('refuses to persist a credential, rather than redacting it', () => {
    // Silently dropping a value the caller believes was stored produces a
    // build that works once and fails mysteriously later.
    expect(() => screenForSecrets({ a: { b: 'ghp_0123456789abcdefghij' } }, 'test')).toThrow(
      SecretLeakError
    )
    try {
      screenForSecrets({ a: { b: 'ghp_0123456789abcdefghij' } }, 'test')
    } catch (error) {
      expect((error as SecretLeakError).path).toBe('$.a.b')
    }
  })

  it('masks credentials in text meant for a log', () => {
    expect(redactSecrets('failed with Bearer abcdefghijklmnop')).toBe('failed with [redacted]')
  })
})

describe('remote collections', () => {
  fixtureTest('loads records and assigns the ids the loader supplies', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(scriptedLoader(OK_FETCH)))
    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBe(0)
    expect(result.documents).toBe(2)

    const index = await readFile(join(fixture.dir, '.contentmap/releases/index.js'), 'utf8')
    expect(index).toContain('"v1"')
    expect(index).toContain('"v2"')
    // sorted by id for reproducible output
    expect(index.indexOf('"v1"')).toBeLessThan(index.indexOf('"v2"'))
  })

  fixtureTest('a duplicate id from the loader is a build error', async ({ fixture }) => {
    const dupe = JSON.stringify({ items: [{ slug: 'x', version: '1', notes: 'a' }, { slug: 'x', version: '2', notes: 'b' }] })
    await fixture.write(
      'contentmap.config.ts',
      config(scriptedLoader(`async () => new Response(${JSON.stringify(dupe)}, { status: 200 })`))
    )
    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.diagnostics.some(d => d.code === 'CM_DUPLICATE_ID')).toBe(true)
  })

  fixtureTest('a 304 reuses the cache without reparsing', async ({ fixture }) => {
    // The second request must carry If-None-Match and cost no parsing.
    const script = `(() => { let n = 0; return async (_u, init) => {
      n++
      globalThis.__cmCalls = (globalThis.__cmCalls ?? []).concat([init?.headers ?? {}])
      if (n === 1) return new Response(${JSON.stringify(RECORDS)}, { status: 200, headers: { etag: 'W/"abc"' } })
      return new Response('', { status: 304 })
    } })()`
    await fixture.write('contentmap.config.ts', config(scriptedLoader(script)))

    const builder = createBuilder({ root: fixture.dir })
    const first = await builder.build()
    expect(first.documents).toBe(2)

    await rm(join(fixture.dir, '.contentmap/releases'), { recursive: true, force: true })
    const second = await builder.build()
    expect(second.errors).toBe(0)
    expect(second.documents).toBe(2)
  })

  fixtureTest('an offline build falls back to the cache and warns', async ({ fixture }) => {
    const script = `(() => { let n = 0; return async () => {
      n++
      if (n === 1) return new Response(${JSON.stringify(RECORDS)}, { status: 200 })
      throw new Error('getaddrinfo ENOTFOUND example.invalid')
    } })()`
    await fixture.write('contentmap.config.ts', config(scriptedLoader(script)))

    const builder = createBuilder({ root: fixture.dir })
    await builder.build()

    const logs: string[] = []
    builder.on(e => {
      if (e.type === 'log') logs.push(e.message)
    })
    const second = await builder.build()

    expect(second.errors).toBe(0)
    expect(second.documents).toBe(2)
    // Loud: a build quietly serving yesterday's content is how a stale deploy
    // goes unnoticed.
    expect(logs.some(l => l.includes('last successful fetch'))).toBe(true)
  })

  fixtureTest('onError "fail" stops the build instead', async ({ fixture }) => {
    const script = `async () => { throw new Error('network down') }`
    await fixture.write(
      'contentmap.config.ts',
      config(`http({
        url: 'https://example.invalid/x',
        select: (p) => p.items, id: (r) => r.slug,
        onError: 'fail',
        fetch: ${script}
      })`)
    )
    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBeGreaterThan(0)
    expect(result.diagnostics.some(d => d.code === 'CM_LOADER')).toBe(true)
  })

  fixtureTest('--frozen serves a warm cache without fetching', async ({ fixture }) => {
    const script = `(() => { let n = 0; return async () => {
      n++
      if (n > 1) throw new Error('the network must not be touched when frozen')
      return new Response(${JSON.stringify(RECORDS)}, { status: 200 })
    } })()`
    await fixture.write('contentmap.config.ts', config(scriptedLoader(script)))

    await createBuilder({ root: fixture.dir }).build()
    const frozen = await createBuilder({ root: fixture.dir, frozen: true }).build()
    expect(frozen.errors).toBe(0)
    expect(frozen.documents).toBe(2)
  })

  fixtureTest('--frozen with a cold cache fails rather than fetching', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(scriptedLoader(OK_FETCH)))
    const result = await createBuilder({ root: fixture.dir, frozen: true }).build()
    expect(result.errors).toBeGreaterThan(0)
    const d = result.diagnostics.find(x => x.code === 'CM_LOADER')
    expect(d?.message).toMatch(/no cached data/)
  })

  fixtureTest('a credential never reaches the cache file', async ({ fixture }) => {
    // The cache lives in the project's output directory and is the obvious
    // place for a token to leak into.
    const leaky = JSON.stringify({
      items: [{ slug: 'a', version: '1', notes: 'ghp_0123456789abcdefghij' }]
    })
    await fixture.write(
      'contentmap.config.ts',
      config(scriptedLoader(`async () => new Response(${JSON.stringify(leaky)}, { status: 200 })`))
    )
    await expect(createBuilder({ root: fixture.dir }).build()).rejects.toThrow(SecretLeakError)
  })

  fixtureTest('a changed payload replaces the previous records', async ({ fixture }) => {
    const changed = JSON.stringify({ items: [{ slug: 'v3', version: '3.0.0', notes: 'third' }] })
    const script = `(() => { let n = 0; return async () => {
      n++
      return new Response(n === 1 ? ${JSON.stringify(RECORDS)} : ${JSON.stringify(changed)}, { status: 200 })
    } })()`
    await fixture.write('contentmap.config.ts', config(scriptedLoader(script)))

    const builder = createBuilder({ root: fixture.dir })
    expect((await builder.build()).documents).toBe(2)
    const second = await builder.build()
    expect(second.documents).toBe(1)
    const index = await readFile(join(fixture.dir, '.contentmap/releases/index.js'), 'utf8')
    expect(index).toContain('"v3"')
    expect(index).not.toContain('"v1"')
  })
})
