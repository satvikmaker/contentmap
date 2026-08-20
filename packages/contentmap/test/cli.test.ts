import { describe, expect, it } from 'vitest'
import { rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBuilder } from '../src/builder.ts'
import { run } from '../src/cli/run.ts'
import { init } from '../src/cli/init.ts'
import { codeFrame } from '../src/diagnostics/frame.ts'
import { fixtureTest } from './helpers.ts'

const SRC = pathToFileURL(resolve(import.meta.dirname, '../src/index.ts')).href

const config = (body: string): string =>
  `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}\n` +
  `import { z } from 'zod'\n\n${body}\n`

const POSTS = `
const posts = defineCollection({
  name: 'posts',
  directory: 'content',
  include: '**/*.md',
  schema: z.object({ title: z.string() }),
  transform: doc => ({ ...doc, upper: doc.title.toUpperCase() })
})
export default defineConfig({ collections: { posts } })
`

/** Capture what the CLI writes, so assertions read the real output. */
async function capture(
  fn: () => Promise<number>
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const stdout = process.stdout.write.bind(process.stdout)
  const stderr = process.stderr.write.bind(process.stderr)
  process.stdout.write = (chunk: string | Uint8Array): boolean => (out.push(String(chunk)), true)
  process.stderr.write = (chunk: string | Uint8Array): boolean => (err.push(String(chunk)), true)
  try {
    return { code: await fn(), out: out.join(''), err: err.join('') }
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
}

describe('phase timing', () => {
  fixtureTest('reports every pipeline stage, and only leaves', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(POSTS))
    for (let i = 0; i < 5; i++) {
      await fixture.write(`content/p${i}.md`, `---\ntitle: P${i}\n---\nBody`)
    }

    const result = await createBuilder({ root: fixture.dir }).build()

    // The stages a build actually passes through. Timing an envelope as well as
    // its contents produces a table whose largest row is an alias for several
    // of the others, which reads as a finding and is really an artefact.
    expect(Object.keys(result.phases).sort()).toEqual(
      ['config', 'emit', 'parse', 'read', 'transform', 'validate'].sort()
    )
    for (const ms of Object.values(result.phases)) expect(ms).toBeGreaterThanOrEqual(0)
  })

  fixtureTest('starts each build from zero rather than accumulating', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(POSTS))
    await fixture.write('content/a.md', '---\ntitle: A\n---\nBody')

    const builder = createBuilder({ root: fixture.dir })
    const first = await builder.build()
    const second = await builder.build()

    // The second build is a cache hit, so nothing is parsed. If the map
    // accumulated instead of resetting, build one's `parse` would still be
    // sitting there — which is the failure this pins, and it needs no timing
    // threshold to detect.
    expect(first.phases['parse']).toBeTypeOf('number')
    expect(second.phases['parse']).toBeUndefined()
  })
})

describe('cli', () => {
  fixtureTest(
    'rejects a non-numeric --concurrency instead of passing NaN down',
    async ({ fixture }) => {
      await fixture.write('contentmap.config.ts', config(POSTS))
      await fixture.write('content/a.md', '---\ntitle: A\n---\nBody')

      // NaN would reach the builder as an unbounded fan-out and blow the
      // file-descriptor limit on a large corpus.
      const { code, err } = await capture(() =>
        run(['build', '--concurrency', 'abc', '--config', `${fixture.dir}/contentmap.config.ts`])
      )

      expect(code).toBe(1)
      expect(err).toContain('--concurrency expects a non-negative number')
    }
  )

  fixtureTest('--verbose prints the phase table it promises', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(POSTS))
    await fixture.write('content/a.md', '---\ntitle: A\n---\nBody')

    const { code, err } = await capture(() =>
      run(['build', '--verbose', '--config', `${fixture.dir}/contentmap.config.ts`])
    )

    expect(code).toBe(0)
    expect(err).toContain('cumulative')
    expect(err).toContain('parse')
    // The numbers overlap, so claiming they partition the total would be a lie.
    expect(err).toContain('do not sum to it')
  })

  fixtureTest('--json carries phases for per-commit tracking', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(POSTS))
    await fixture.write('content/a.md', '---\ntitle: A\n---\nBody')

    const { out } = await capture(() =>
      run(['build', '--json', '--config', `${fixture.dir}/contentmap.config.ts`])
    )

    const parsed = JSON.parse(out) as { phases: Record<string, number> }
    expect(parsed.phases['parse']).toBeTypeOf('number')
  })

  fixtureTest('--version reports the installed version, not a literal', async () => {
    const { code, out } = await capture(() => run(['--version']))
    expect(code).toBe(0)
    // Read from the manifest beside the bundle; 'unknown' would mean the lookup
    // broke, which is the failure this guards.
    expect(out.trim()).not.toBe('unknown')
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('init', () => {
  fixtureTest('names the packages a scaffolded project still needs', async ({ fixture }) => {
    // The generated config imports contentmap and zod. Scaffolding a project
    // that cannot build, then failing on the next command with "Cannot find
    // module 'zod'", is a worse first run than one extra line of output.
    await fixture.write(
      'package.json',
      JSON.stringify({ name: 'x', dependencies: { next: '^16' } })
    )

    const result = await init({ root: fixture.dir })

    expect(result.install).toContain('contentmap')
    expect(result.install).toContain('zod')
    expect(result.install).toContain('@contentmap/next')
  })

  fixtureTest('does not ask for what is already installed', async ({ fixture }) => {
    await fixture.write(
      'package.json',
      JSON.stringify({ name: 'x', dependencies: { next: '^16', zod: '^4', contentmap: '^1' } })
    )

    const result = await init({ root: fixture.dir })

    expect(result.install).toEqual(['@contentmap/next'])
  })
})

describe('cache directory', () => {
  fixtureTest('can live outside the output directory', async ({ fixture }) => {
    // CI mounts a cache volume, and a bundler that cleans its own output
    // directory should not be able to take the cache with it.
    await fixture.write('contentmap.config.ts', config(POSTS))
    await fixture.write('content/a.md', '---\ntitle: A\n---\nBody')

    const cacheDir = join(fixture.dir, 'node_modules/.cache/contentmap')
    await createBuilder({ root: fixture.dir, cacheDir }).build()

    await expect(stat(join(cacheDir, 'assets.json'))).resolves.toBeTruthy()
    // And nothing was left in the default location.
    await expect(stat(join(fixture.dir, '.contentmap/.cache'))).rejects.toThrow()
  })

  fixtureTest('survives a clean that wipes the output directory', async ({ fixture }) => {
    await fixture.write('contentmap.config.ts', config(POSTS))
    await fixture.write('content/a.md', '---\ntitle: A\n---\nBody')

    const cacheDir = join(fixture.dir, 'node_modules/.cache/contentmap')
    await createBuilder({ root: fixture.dir, cacheDir }).build()
    await createBuilder({ root: fixture.dir, cacheDir, clean: true }).build()

    await expect(stat(join(cacheDir, 'assets.json'))).resolves.toBeTruthy()
  })

  fixtureTest('refuses to be the output directory itself', async ({ fixture }) => {
    // There is no honest clean in that configuration: removing the directory
    // destroys the cache, keeping it makes --clean a silent no-op.
    await fixture.write('contentmap.config.ts', config(POSTS))
    await fixture.write('content/a.md', '---\ntitle: A\n---\nBody')

    await expect(
      createBuilder({ root: fixture.dir, cacheDir: join(fixture.dir, '.contentmap') }).build()
    ).rejects.toThrow(/must not be the output directory/)
  })

  fixtureTest('a clean still removes generated documents', async ({ fixture }) => {
    // Keeping the cache must not turn --clean into a no-op: a document deleted
    // from disk has to disappear from the output too.
    await fixture.write('contentmap.config.ts', config(POSTS))
    await fixture.write('content/a.md', '---\ntitle: A\n---\nBody')
    await fixture.write('content/b.md', '---\ntitle: B\n---\nBody')
    await createBuilder({ root: fixture.dir }).build()
    await expect(stat(join(fixture.dir, '.contentmap/posts/b.js'))).resolves.toBeTruthy()

    await rm(join(fixture.dir, 'content/b.md'))
    await createBuilder({ root: fixture.dir, clean: true }).build()

    await expect(stat(join(fixture.dir, '.contentmap/posts/b.js'))).rejects.toThrow()
    await expect(stat(join(fixture.dir, '.contentmap/posts/a.js'))).resolves.toBeTruthy()
  })
})

describe('code frame', () => {
  it('never points past the end of the line', () => {
    // jiti reports positions in its own compiled output, so a column can exceed
    // the original line. A caret floating far past the last character points at
    // nothing while implying the line runs on.
    const frame = codeFrame("import { x } from 'y'\n", { line: 1, column: 221 })
    const caret = frame.split('\n').find(l => l.includes('^')) ?? ''

    expect(caret.indexOf('^')).toBeLessThanOrEqual(frame.split('\n')[0]?.length ?? 0)
  })
})
