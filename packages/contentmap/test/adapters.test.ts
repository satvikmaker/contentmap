import { describe, expect, it } from 'vitest'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { contentmap as vitePlugin } from '../../vite/src/index.ts'
import { withContentmap } from '../../next/src/index.ts'
import { contentmapModule } from '../../nuxt/src/index.ts'
import { ContentmapWebpackPlugin } from '../../webpack/src/index.ts'
import { createBuilder } from '../src/builder.ts'
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

async function seed(fixture: { write: (p: string, c: string) => Promise<string> }) {
  await fixture.write('contentmap.config.ts', CONFIG)
  await fixture.write('content/a.md', '---\ntitle: A\n---\nbody')
  await fixture.write('content/b.md', '---\ntitle: B\n---\nbody')
}

/** Read every generated file, so two builds can be compared byte for byte. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (path: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      // The cache is build state, not output.
      if (entry.name === '.cache') continue
      const child = join(path, entry.name)
      const key = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(child, key)
      else out[key] = await readFile(child, 'utf8')
    }
  }
  await walk(dir, '')
  return out
}

// ── the M8 gate ──────────────────────────────────────────────────────────────
describe('adapters are convenience, never a requirement', () => {
  fixtureTest('the vite plugin produces exactly what the CLI does', async ({ fixture }) => {
    // If a plugin can change the output, the CLI is no longer the product and
    // the next bundler that drops plugin support takes the tool with it —
    // which is precisely what happened to contentlayer when Turbopack landed.
    await seed(fixture)
    await createBuilder({ root: fixture.dir }).build()
    const viaCli = await snapshot(join(fixture.dir, '.contentmap'))

    await rm(join(fixture.dir, '.contentmap'), { recursive: true, force: true })

    const plugin = vitePlugin()
    await plugin.config?.({ root: fixture.dir })
    await plugin.configResolved?.({ root: fixture.dir, command: 'build' })
    const viaPlugin = await snapshot(join(fixture.dir, '.contentmap'))

    expect(Object.keys(viaPlugin).sort()).toEqual(Object.keys(viaCli).sort())
    for (const [file, content] of Object.entries(viaCli)) {
      expect(viaPlugin[file], file).toBe(content)
    }
  })
})

describe('vite plugin', () => {
  fixtureTest('resolves the generated module even when disabled', async ({ fixture }) => {
    // Hooks are called in Vite's real order: `config` comes first, which is why
    // the alias has to be resolved there. Calling them the other way round hid
    // an alias of `undefined` that a real build rejects outright.
    await seed(fixture)
    const plugin = vitePlugin({ isEnabled: () => false })
    const config = (await plugin.config?.({ root: fixture.dir })) as {
      resolve: { alias: Record<string, string> }
    }
    await plugin.configResolved?.({ root: fixture.dir, command: 'build' })

    expect(config.resolve.alias['contentmap/generated']).toContain('.contentmap')
    // A disabled instance still resolves imports, but writes nothing.
    await expect(readdir(join(fixture.dir, '.contentmap'))).rejects.toThrow()
  })

  fixtureTest('patches server.fs.allow instead of replacing it', async ({ fixture }) => {
    // SvelteKit sets its own allow list; overwriting it makes the dev server
    // return 403 for its own files.
    await seed(fixture)
    const viteConfig = { root: fixture.dir, command: 'build' as const, server: { fs: { allow: ['/existing'] } } }
    const plugin = vitePlugin()
    await plugin.config?.({ root: fixture.dir })
    await plugin.configResolved?.(viteConfig)
    expect(viteConfig.server.fs.allow).toContain('/existing')
    expect(viteConfig.server.fs.allow.some(p => p.includes('.contentmap'))).toBe(true)
  })

  fixtureTest('builds once across several environments', async ({ fixture }) => {
    // Vite 6 runs one plugin instance per environment, and SvelteKit evaluates
    // the whole config twice.
    await seed(fixture)
    const plugin = vitePlugin()
    await plugin.config?.({ root: fixture.dir })
    const cfg = { root: fixture.dir, command: 'build' as const }
    await Promise.all([
      plugin.configResolved?.(cfg),
      plugin.configResolved?.(cfg),
      plugin.configResolved?.(cfg)
    ])
    const index = await readFile(join(fixture.dir, '.contentmap/posts/index.js'), 'utf8')
    expect(index).toContain('"a"')
  })
})

describe('next adapter', () => {
  fixtureTest('looks like a plain config to everything except await', async ({ fixture }) => {
    await seed(fixture)
    const config = withContentmap({ reactStrictMode: true }, { root: fixture.dir, watch: false })

    // An enumerable `then` would make the config itself look like a promise.
    expect(Object.keys(config)).toEqual(['reactStrictMode'])
    expect(JSON.parse(JSON.stringify(config))).toEqual({ reactStrictMode: true })
    expect(Object.prototype.propertyIsEnumerable.call(config, 'then')).toBe(false)

    // Awaiting blocks until generation is on disk, which is how Next avoids
    // compiling against output that does not exist yet.
    const awaited = await config
    expect(awaited).toEqual({ reactStrictMode: true })
    const index = await readFile(join(fixture.dir, '.contentmap/posts/index.js'), 'utf8')
    expect(index).toContain('"a"')
  })

  fixtureTest('does not touch the bundler configuration', async ({ fixture }) => {
    // Turbopack hard-fails on a `webpack` key, and supports no plugins at all.
    await seed(fixture)
    const config = withContentmap({}, { root: fixture.dir, watch: false })
    await config
    expect('webpack' in config).toBe(false)
    expect('turbopack' in config).toBe(false)
  })

  fixtureTest('builds nothing under `next start`', async ({ fixture }) => {
    await seed(fixture)
    const argv = process.argv
    process.argv = [argv[0]!, argv[1]!, 'start']
    try {
      await withContentmap({}, { root: fixture.dir, watch: false })
      await expect(readdir(join(fixture.dir, '.contentmap'))).rejects.toThrow()
    } finally {
      process.argv = argv
    }
  })
})

describe('nuxt module', () => {
  const makeNuxt = (root: string, prepare = false) => ({
    options: {
      rootDir: root,
      alias: {} as Record<string, string>,
      _prepare: prepare,
      nitro: {} as Record<string, unknown>,
      typescript: {} as Record<string, unknown>
    },
    hooks: [] as string[],
    hook(name: string) {
      this.hooks.push(name)
    }
  })

  fixtureTest('registers the alias and BOTH tsconfig paths', async ({ fixture }) => {
    // Nitro type-checks separately; registering only the app tsconfig leaves
    // server routes unable to resolve the generated module.
    await seed(fixture)
    const nuxt = makeNuxt(fixture.dir)
    await contentmapModule({ watch: false }).setup({}, nuxt as never)

    expect(nuxt.options.alias['contentmap/generated']).toContain('.contentmap')
    const app = (nuxt.options.typescript as never as { tsConfig: { compilerOptions: { paths: Record<string, string[]> } } })
    const nitro = (nuxt.options.nitro as never as { typescript: { tsConfig: { compilerOptions: { paths: Record<string, string[]> } } } })
    expect(app.tsConfig.compilerOptions.paths['contentmap/generated']).toBeDefined()
    expect(nitro.typescript.tsConfig.compilerOptions.paths['contentmap/generated']).toBeDefined()
  })

  fixtureTest('does not start a watcher during `nuxt prepare`', async ({ fixture }) => {
    // prepare exists to emit types without building; a watcher leaves it hanging.
    await seed(fixture)
    const nuxt = makeNuxt(fixture.dir, true)
    await contentmapModule().setup({}, nuxt as never)
    expect(nuxt.hooks).not.toContain('close')
    const index = await readFile(join(fixture.dir, '.contentmap/posts/index.js'), 'utf8')
    expect(index).toContain('"a"')
  })
})

describe('webpack plugin', () => {
  fixtureTest('builds once across the node, edge and client compilers', async ({ fixture }) => {
    await seed(fixture)
    let calls = 0
    const compiler = () => ({
      options: { mode: 'production' },
      hooks: {
        beforeCompile: {
          tapPromise: (_n: string, fn: () => Promise<void>) => {
            hooks.push(fn)
          }
        }
      }
    })
    const hooks: (() => Promise<void>)[] = []
    const plugin = new ContentmapWebpackPlugin({ root: fixture.dir, watch: false })
    for (let i = 0; i < 3; i++) plugin.apply(compiler() as never)

    const builder = createBuilder({ root: fixture.dir })
    builder.on(e => {
      if (e.type === 'build:start') calls++
    })
    await Promise.all(hooks.map(fn => fn()))

    const index = await readFile(join(fixture.dir, '.contentmap/posts/index.js'), 'utf8')
    expect(index).toContain('"a"')
    // Three compilers, one build. contentlayer's hook fires three times.
    expect(hooks).toHaveLength(3)
  })
})
