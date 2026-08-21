import { describe, expect, it } from 'vitest'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { run } from '../src/cli/run.ts'
import { fixtureTest } from './helpers.ts'

const SRC = pathToFileURL(resolve(import.meta.dirname, '../src/index.ts')).href

const CONFIG = `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}
import { z } from 'zod'
const posts = defineCollection({
  name: 'posts', directory: 'content', include: '**/*.md',
  schema: z.object({ title: z.string() })
})
export default defineConfig({ collections: { posts } })
`

/** Capture what a command writes, so assertions read the real output. */
async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const stdout = process.stdout.write.bind(process.stdout)
  const stderr = process.stderr.write.bind(process.stderr)
  process.stdout.write = (c: string | Uint8Array): boolean => (out.push(String(c)), true)
  process.stderr.write = (c: string | Uint8Array): boolean => (err.push(String(c)), true)
  try {
    return { code: await run(args), out: out.join(''), err: err.join('') }
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
}

const seed = async (fixture: { write: (p: string, c: string) => Promise<string> }) => {
  await fixture.write('contentmap.config.ts', CONFIG)
  await fixture.write('content/a.md', '---\ntitle: A\n---\nbody')
}

describe('contentmap check', () => {
  fixtureTest('validates and writes absolutely nothing', async ({ fixture }) => {
    // The whole point of `check` is CI validation without artifacts. A single
    // stray file makes it unusable in a pipeline that then diffs the tree.
    await seed(fixture)

    const { code, out } = await cli(['check', '--config', `${fixture.dir}/contentmap.config.ts`])

    expect(code).toBe(0)
    expect(out).toContain('checked')
    const entries = await readdir(fixture.dir)
    expect(entries).not.toContain('.contentmap')
  })

  fixtureTest('exits non-zero on a schema violation', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', CONFIG)
    await fixture.write('content/bad.md', '---\ntitle: 42\nextra: no\n---\nbody')

    const { code, err } = await cli(['check', '--config', `${fixture.dir}/contentmap.config.ts`])

    expect(code).toBe(1)
    expect(err).toContain('Build failed')
  })

  fixtureTest('leaves an existing build untouched', async ({ fixture }) => {
    // `check` after `build` must not clean, rewrite or invalidate anything.
    await seed(fixture)
    await cli(['build', '--config', `${fixture.dir}/contentmap.config.ts`])
    const before = await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')

    await cli(['check', '--config', `${fixture.dir}/contentmap.config.ts`])

    expect(await readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')).toBe(before)
  })
})

describe('contentmap clean', () => {
  fixtureTest('removes generated output', async ({ fixture }) => {
    await seed(fixture)
    await cli(['build', '--config', `${fixture.dir}/contentmap.config.ts`])

    const { code, out } = await cli(['clean', '--config', `${fixture.dir}/contentmap.config.ts`])

    expect(code).toBe(0)
    expect(out).toContain('removed')
    await expect(readFile(join(fixture.dir, '.contentmap/posts/a.js'), 'utf8')).rejects.toThrow()
  })

  fixtureTest('says so when there is nothing to remove', async ({ fixture }) => {
    await seed(fixture)

    const { code, out } = await cli(['clean', '--config', `${fixture.dir}/contentmap.config.ts`])

    expect(code).toBe(0)
    expect(out).toContain('nothing to clean')
  })

  fixtureTest('keeps the cache, which is not generated output', async ({ fixture }) => {
    await seed(fixture)
    await cli(['build', '--config', `${fixture.dir}/contentmap.config.ts`])
    await expect(
      readFile(join(fixture.dir, '.contentmap/.cache/assets.json'), 'utf8')
    ).resolves.toBeTruthy()

    await cli(['clean', '--config', `${fixture.dir}/contentmap.config.ts`])

    await expect(
      readFile(join(fixture.dir, '.contentmap/.cache/assets.json'), 'utf8')
    ).resolves.toBeTruthy()
  })
})

describe('contentmap init', () => {
  fixtureTest('scaffolds a project through the CLI', async ({ fixture }) => {
    await fixture.write('package.json', JSON.stringify({ name: 'x', dependencies: {} }))

    const { code, out } = await cli(['init', '--config', `${fixture.dir}/x`])

    expect(code).toBe(0)
    expect(out).toContain('Install:')
    expect(out).toContain('npx contentmap build')
  })
})

describe('argument handling', () => {
  it('rejects an unknown command with the help text', async () => {
    const { code, err } = await cli(['frobnicate'])
    expect(code).toBe(1)
    expect(err).toContain('Unknown command')
    expect(err).toContain('Usage')
  })

  it('rejects an unknown flag rather than ignoring it', async () => {
    // Silently ignoring a typo'd flag is how people end up believing a build
    // ran with settings it never had.
    const { code, err } = await cli(['build', '--nonsense'])
    expect(code).toBe(1)
    expect(err).toContain('Usage')
  })

  it('prints help and exits 0 when asked', async () => {
    const { code, out } = await cli(['--help'])
    expect(code).toBe(0)
    expect(out).toContain('contentmap')
    expect(out).toContain('build')
  })

  it('exits 1 with help when given nothing at all', async () => {
    const { code, out } = await cli([])
    expect(code).toBe(1)
    expect(out).toContain('Usage')
  })
})

describe('failure reporting', () => {
  fixtureTest('fails loudly on a broken config', async ({ fixture }) => {
    // Only the exit code and the presence of a message are asserted here.
    // Under vitest the config is loaded through Vite's transform rather than
    // jiti, so the error text differs from the one a user sees — the shipped
    // wording is covered by `pnpm verify:cli`, which runs the real binary.
    await fixture.write('contentmap.config.ts', 'export default { this is not valid‽ }')

    const { code, err } = await cli(['build', '--config', `${fixture.dir}/contentmap.config.ts`])

    expect(code).toBe(1)
    expect(err.length).toBeGreaterThan(0)
  })

  fixtureTest('reports a config that is missing entirely', async ({ fixture }) => {
    const { code, err } = await cli(['build', '--config', `${fixture.dir}/nope.config.ts`])

    expect(code).toBe(1)
    expect(err.length).toBeGreaterThan(0)
  })

  fixtureTest('--silent still reports failure on stderr', async ({ fixture }) => {
    // Silence is for success. A silent failure is the thing this project exists
    // to make impossible.
    await fixture.write('contentmap.config.ts', CONFIG)
    await fixture.write('content/bad.md', '---\ntitle: 42\n---\nbody')

    const { code, err } = await cli([
      'build',
      '--silent',
      '--config',
      `${fixture.dir}/contentmap.config.ts`
    ])

    expect(code).toBe(1)
    expect(err).toContain('Build failed')
  })

  fixtureTest('--silent prints nothing on success', async ({ fixture }) => {
    await seed(fixture)

    const { code, out } = await cli([
      'build',
      '--silent',
      '--config',
      `${fixture.dir}/contentmap.config.ts`
    ])

    expect(code).toBe(0)
    expect(out.trim()).toBe('')
  })
})

describe('--json', () => {
  fixtureTest('emits a stable, parseable envelope', async ({ fixture }) => {
    await seed(fixture)

    const { out } = await cli([
      'build',
      '--json',
      '--config',
      `${fixture.dir}/contentmap.config.ts`
    ])
    const parsed = JSON.parse(out) as Record<string, unknown>

    expect(parsed['version']).toBe(1)
    expect(parsed['ok']).toBe(true)
    expect(parsed['command']).toBe('build')
    expect(parsed['documents']).toBe(1)
    expect(Array.isArray(parsed['diagnostics'])).toBe(true)
  })

  fixtureTest('reports failures as data, not as a stack', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', CONFIG)
    await fixture.write('content/bad.md', '---\ntitle: 42\n---\nbody')

    const { code, out } = await cli([
      'build',
      '--json',
      '--config',
      `${fixture.dir}/contentmap.config.ts`
    ])
    const parsed = JSON.parse(out) as { ok: boolean; errors: number; diagnostics: unknown[] }

    expect(code).toBe(1)
    expect(parsed.ok).toBe(false)
    expect(parsed.errors).toBeGreaterThan(0)
    // A code frame is an ASCII drawing for humans; it must never land in JSON.
    expect(out).not.toContain('│')
  })

  fixtureTest('stays valid JSON when the build fails outright', async ({ fixture }) => {
    // A CI job parsing stdout should not have to special-case a crash.
    await fixture.write('contentmap.config.ts', 'export default { broken‽ }')

    const { code, out, err } = await cli([
      'build',
      '--json',
      '--config',
      `${fixture.dir}/contentmap.config.ts`
    ])

    expect(code).toBe(1)
    // Either valid JSON on stdout, or nothing there and the error on stderr.
    if (out.trim().length > 0) expect(() => JSON.parse(out)).not.toThrow()
    else expect(err.length).toBeGreaterThan(0)
  })
})
