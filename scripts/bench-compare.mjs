// Head-to-head benchmark against the tools contentmap replaces.
//
// No comparative benchmark exists anywhere for velite, content-collections or
// contentlayer2 — each publishes either nothing or self-run numbers on a
// different corpus. This builds ONE corpus and runs all four over it.
//
// Every tool is configured as close to like-for-like as its API allows:
// frontmatter parsing, schema validation, and emitting typed output. Where a
// tool cannot be configured that way, the difference is reported rather than
// hidden.
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises'
import { cpus, loadavg, availableParallelism, totalmem } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const N = Number(process.argv[2] ?? 1000)
const ROOT = join(process.cwd(), '.compare')
const CM = process.cwd()

const TOOLS = [
  {
    id: 'contentmap',
    install: ['__TARBALL__', 'zod@^4'],
    files: {
      'contentmap.config.ts': `import { defineConfig, defineCollection } from 'contentmap'
import { z } from 'zod'
const posts = defineCollection({
  name: 'posts', directory: 'content', include: '**/*.md',
  schema: z.object({ title: z.string(), date: z.coerce.date(), tags: z.array(z.string()) })
})
export default defineConfig({ collections: { posts } })
`
    },
    cmd: ['npx', ['contentmap', 'build']],
    out: '.contentmap'
  },
  {
    id: 'velite',
    install: ['velite@^0.4'],
    files: {
      'velite.config.ts': `import { defineConfig, defineCollection, s } from 'velite'
const posts = defineCollection({
  name: 'Post', pattern: '**/*.md',
  schema: s.object({ title: s.string(), date: s.isodate(), tags: s.array(s.string()) })
})
export default defineConfig({ root: 'content', collections: { posts } })
`
    },
    cmd: ['npx', ['velite', 'build']],
    out: '.velite'
  },
  {
    id: 'content-collections',
    install: ['@content-collections/core@^0.15', '@content-collections/cli@^0.1', 'zod@^3'],
    files: {
      'content-collections.ts': `import { defineCollection, defineConfig } from '@content-collections/core'
import { z } from 'zod'
const posts = defineCollection({
  name: 'posts', directory: 'content', include: '**/*.md', parser: 'frontmatter',
  schema: z.object({ title: z.string(), date: z.string(), tags: z.array(z.string()), content: z.string() })
})
export default defineConfig({ collections: [posts] })
`
    },
    cmd: ['npx', ['content-collections', 'build']],
    out: '.content-collections'
  },
  {
    id: 'contentlayer2',
    install: ['contentlayer2@^0.5'],
    files: {
      'contentlayer.config.ts': `import { defineDocumentType, makeSource } from 'contentlayer2/source-files'
export const Post = defineDocumentType(() => ({
  name: 'Post', filePathPattern: '**/*.md',
  fields: { title: { type: 'string', required: true }, date: { type: 'date', required: true }, tags: { type: 'list', of: { type: 'string' } } }
}))
export default makeSource({ contentDirPath: 'content', documentTypes: [Post] })
`
    },
    cmd: ['npx', ['contentlayer2', 'build']],
    out: '.contentlayer'
  }
]

const body = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n\n'.repeat(8)

async function dirSize(path) {
  let total = 0
  const walk = async p => {
    for (const e of await readdir(p, { withFileTypes: true })) {
      const child = join(p, e.name)
      if (e.isDirectory()) await walk(child)
      else total += (await stat(child)).size
    }
  }
  try {
    await walk(path)
  } catch {
    return 0
  }
  return total
}

/**
 * Count every installed package, nested ones included.
 *
 * Counting only the top level understates a tool whose dependencies were
 * hoisted elsewhere — the first version of this script symlinked contentmap
 * into the fixture, so its dependencies resolved from the workspace and it
 * reported 2 packages against its rivals' real installs. Flattering, and wrong.
 */
async function packageCount(dir) {
  let n = 0
  const walk = async p => {
    let entries
    try {
      entries = await readdir(p, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const child = join(p, e.name)
      if (e.name === 'node_modules') {
        await walk(child)
        continue
      }
      if (e.name.startsWith('@')) {
        await walk(child)
        continue
      }
      try {
        await stat(join(child, 'package.json'))
        n++
      } catch {
        /* not a package */
      }
      await walk(join(child, 'node_modules'))
    }
  }
  await walk(join(dir, 'node_modules'))
  return n
}

// Packed and installed like a published package, so its dependency tree is
// measured the same way every other tool's is.
await rm(ROOT, { recursive: true, force: true })
await mkdir(ROOT, { recursive: true })
const packed = await run('npm', ['pack', '--pack-destination', ROOT], {
  cwd: join(CM, 'packages/contentmap')
})
const tarball = join(ROOT, packed.stdout.trim().split('\n').pop())
TOOLS[0].install = TOOLS[0].install.map(x => (x === '__TARBALL__' ? tarball : x))

console.log(`corpus   ${N.toLocaleString()} markdown documents`)
console.log(
  `machine  ${cpus()[0]?.model} / ${availableParallelism()} cores / ${Math.round(totalmem() / 1024 ** 3)}GB / node ${process.version}`
)
console.log(`load     ${loadavg()[0].toFixed(1)}\n`)

const results = []
for (const tool of TOOLS) {
  const dir = join(ROOT, tool.id)
  await mkdir(join(dir, 'content'), { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: `bench-${tool.id}`, private: true, type: 'module' }, null, 2)
  )
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      writeFile(
        join(dir, `content/p${i}.md`),
        `---\ntitle: Post ${i}\ndate: 2026-01-0${(i % 9) + 1}\ntags: [a, b]\n---\n\n# Post ${i}\n\n${body}`
      )
    )
  )
  for (const [name, content] of Object.entries(tool.files))
    await writeFile(join(dir, name), content)

  let installed = true
  const t0 = Date.now()
  try {
    await run('npm', ['install', '--silent', '--no-audit', '--no-fund', ...tool.install], {
      cwd: dir,
      timeout: 300_000
    })
  } catch (e) {
    installed = false
    results.push({
      id: tool.id,
      error: `install failed: ${String(e.message).split('\n')[0].slice(0, 90)}`
    })
    continue
  }
  const installMs = Date.now() - t0

  let cold, warm, error
  try {
    const [bin, args] = tool.cmd
    const s1 = Date.now()
    await run(bin, args, {
      cwd: dir,
      timeout: 600_000,
      env: { ...process.env, NODE_ENV: 'production' }
    })
    cold = Date.now() - s1
    const s2 = Date.now()
    await run(bin, args, {
      cwd: dir,
      timeout: 600_000,
      env: { ...process.env, NODE_ENV: 'production' }
    })
    warm = Date.now() - s2
  } catch (e) {
    error = String(e.stderr || e.message)
      .split('\n')
      .filter(Boolean)
      .slice(-1)[0]
      ?.slice(0, 110)
  }

  results.push({
    id: tool.id,
    installMs,
    packages: await packageCount(dir),
    nodeModules: await dirSize(join(dir, 'node_modules')),
    cold,
    warm,
    output: await dirSize(join(dir, tool.out)),
    error,
    installed
  })
}

const mb = n => `${(n / 1024 ** 2).toFixed(1)} MB`
const ms = n => (n === undefined ? '—' : `${(n / 1000).toFixed(2)}s`)
const pad = (s, n) => String(s).padEnd(n)

console.log(
  pad('tool', 22) +
    pad('cold', 9) +
    pad('warm', 9) +
    pad('output', 11) +
    pad('packages', 10) +
    'install size'
)
console.log('-'.repeat(80))
for (const r of results) {
  if (r.error && !r.cold) {
    console.log(pad(r.id, 22) + `FAILED  ${r.error}`)
    continue
  }
  console.log(
    pad(r.id, 22) +
      pad(ms(r.cold), 9) +
      pad(ms(r.warm), 9) +
      pad(mb(r.output), 11) +
      pad(r.packages, 10) +
      mb(r.nodeModules)
  )
}

const noisy = loadavg()[0] > availableParallelism() * 0.7
if (noisy) console.log('\n!  machine busy — timings unreliable; package counts and sizes are not')
await writeFile(
  join(process.cwd(), 'bench-results.json'),
  JSON.stringify({ corpus: N, results }, null, 2)
)
