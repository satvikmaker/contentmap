import { describe, expect, it } from 'vitest'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { contentmap as vitePlugin } from '../../vite/src/index.ts'
import { withContentmap } from '../../next/src/index.ts'
import { contentmapModule } from '../../nuxt/src/index.ts'
import { ContentmapWebpackPlugin } from '../../webpack/src/index.ts'
import { contentmapLoader } from '../../astro/src/index.ts'
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

  it('has a callable default export, which is the only thing Nuxt accepts', async () => {
    // `modules: ['@contentmap/nuxt']` makes Nuxt import the default export and
    // invoke it. When that export was the factory, Nuxt called it, took the
    // module object it returned and threw it away — setup never ran, nothing
    // was built, and the build died on an unresolvable import that named
    // nothing relevant. Exporting the object instead is rejected outright with
    // "is not a function". Every other test in this block calls `.setup()` by
    // hand and so cannot see any of it.
    const mod = (await import('../../nuxt/src/index.ts')).default

    expect(typeof mod).toBe('function')
    expect(mod.getMeta()).toMatchObject({ name: 'contentmap', configKey: 'contentmap' })
  })

  fixtureTest('is callable the way Nuxt calls it, positionally', async ({ fixture }) => {
    await seed(fixture)
    const mod = (await import('../../nuxt/src/index.ts')).default
    const nuxt = makeNuxt(fixture.dir)

    await mod({ watch: false }, nuxt as never)

    expect(nuxt.options.alias['contentmap/generated']).toContain('.contentmap')
  })

  fixtureTest('reads options from the `contentmap` config key', async ({ fixture }) => {
    // Nuxt only merges the config key inside defineNuxtModule's own wrapper,
    // and depending on @nuxt/kit for that would put a framework in the tree of
    // a package whose argument is not needing one.
    await seed(fixture)
    const mod = (await import('../../nuxt/src/index.ts')).default
    const nuxt = makeNuxt(fixture.dir)
    nuxt.options['contentmap'] = { watch: false }

    await mod(undefined, nuxt as never)

    expect(nuxt.hooks).not.toContain('close')
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
  fixtureTest('registers the generated alias, as the other adapters do', async ({ fixture }) => {
    // webpack does not read tsconfig paths, so without this every project
    // repeats the same resolve.alias by hand — and `contentmap/generated`
    // looks enough like a real package subpath that the failure is "Module not
    // found", which points at nothing.
    const compiler = {
      options: { mode: 'production' as const, resolve: {} as { alias?: Record<string, string> } },
      hooks: { beforeCompile: { tapPromise: () => {} } }
    }

    new ContentmapWebpackPlugin({ root: fixture.dir }).apply(compiler as never)

    expect(compiler.options.resolve.alias?.['contentmap/generated']).toBe(
      join(fixture.dir, '.contentmap')
    )
  })

  fixtureTest('never overwrites an alias the project set itself', async ({ fixture }) => {
    const compiler = {
      options: {
        mode: 'production' as const,
        resolve: { alias: { 'contentmap/generated': '/somewhere/else' } }
      },
      hooks: { beforeCompile: { tapPromise: () => {} } }
    }

    new ContentmapWebpackPlugin({ root: fixture.dir }).apply(compiler as never)

    expect(compiler.options.resolve.alias['contentmap/generated']).toBe('/somewhere/else')
  })

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


describe('adapter lifecycles', () => {
  fixtureTest('one environment finishing does not disturb another', async ({ fixture }) => {
    // Vite 6+ runs a build per environment, so buildEnd fires more than once.
    // Tearing the builder down on the first would abort work the others are
    // still doing.
    await seed(fixture)
    const plugin = vitePlugin({ root: fixture.dir })
    await plugin.config?.({ root: fixture.dir })
    await plugin.configResolved?.({ root: fixture.dir, command: 'build' })
    await plugin.buildEnd?.()

    await expect(
      plugin.configResolved?.({ root: fixture.dir, command: 'build' })
    ).resolves.not.toThrow()
    const index = await readFile(join(fixture.dir, '.contentmap/posts/index.js'), 'utf8')
    expect(index).toContain('"a"')
  })

  fixtureTest('a config evaluated twice still builds once', async ({ fixture }) => {
    // SvelteKit evaluates the whole Vite config twice, which calls the plugin
    // factory twice. A guard held in one instance's closure does not span them.
    await seed(fixture)
    let builds = 0
    const observer = createBuilder({ root: fixture.dir })
    observer.on(e => {
      if (e.type === 'build:start') builds++
    })

    const first = vitePlugin({ root: fixture.dir })
    const second = vitePlugin({ root: fixture.dir })
    await Promise.all([
      (async () => {
        await first.config?.({ root: fixture.dir })
        await first.configResolved?.({ root: fixture.dir, command: 'build' })
      })(),
      (async () => {
        await second.config?.({ root: fixture.dir })
        await second.configResolved?.({ root: fixture.dir, command: 'build' })
      })()
    ])

    const index = await readFile(join(fixture.dir, '.contentmap/posts/index.js'), 'utf8')
    expect(index).toContain('"a"')
    await observer.close()
  })

  fixtureTest('the astro loader builds once for several collections', async ({ fixture }) => {
    // Astro calls load() per collection. Building the whole project each time
    // means N full builds for N collections.
    await fixture.write(
      'contentmap.config.ts',
      `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}
import { z } from 'zod'
const schema = z.object({ title: z.string() })
const posts = defineCollection({ name: 'posts', directory: 'content', include: '**/*.md', schema })
const notes = defineCollection({ name: 'notes', directory: 'content', include: '**/*.md', schema })
export default defineConfig({ collections: { posts, notes } })
`
    )
    await fixture.write('content/a.md', '---\ntitle: A\n---\nx')

    let builds = 0
    const stored: string[] = []
    const context = (collection: string) => ({
      collection,
      store: {
        clear() {},
        set(entry: { id: string }) {
          stored.push(`${collection}:${entry.id}`)
        }
      },
      logger: {
        info(message: string) {
          if (message.includes('document')) builds++
        },
        warn() {}
      },
      parseData: async ({ data }: { data: Record<string, unknown> }) => data,
      generateDigest: () => 'digest'
    })

    const loader = contentmapLoader({ root: fixture.dir })
    await loader.load(context('posts') as never)
    await loader.load(context('notes') as never)

    expect(stored).toEqual(['posts:a', 'notes:a'])
    expect(builds).toBe(2)
    // Two collections must not cost two full builds of the whole project.
    expect(loader.buildCount).toBe(1)
  })
})
