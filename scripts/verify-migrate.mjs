// End-to-end: migrate a config, then build the result with contentmap.
//
// The unit tests assert the generated text. Only a real build proves the text
// is a config — that the fields exist, the transform runs, and the rewritten
// context references resolve to something.
import { cp, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { migrate } from '../packages/migrate/src/index.ts'

const repo = resolve(import.meta.dirname, '..')
let failures = 0

/** Packages a migrated config may import, linked the way an install would place them. */
const LINKS = {
  contentmap: join(repo, 'packages/contentmap'),
  zod: join(repo, 'node_modules/zod'),
  '@contentmap/mdx': join(repo, 'packages/mdx'),
  '@contentmap/unified': join(repo, 'packages/unified')
}

async function link(root) {
  for (const [name, target] of Object.entries(LINKS)) {
    const at = join(root, 'node_modules', name)
    await mkdir(dirname(at), { recursive: true })
    // A junction needs no privileges on Windows; elsewhere the type is ignored.
    await symlink(target, at, 'junction')
  }
}

const build = root =>
  spawnSync(process.execPath, [join(repo, 'packages/contentmap/dist/cli.js'), 'build'], {
    cwd: root,
    encoding: 'utf8'
  })

const CONTENTLAYER = `
import { defineDocumentType, makeSource } from 'contentlayer2/source-files'
export const Post = defineDocumentType(() => ({
  name: 'Post',
  filePathPattern: '**/*.md',
  contentType: 'data',
  fields: {
    title: { type: 'string', required: true },
    date: { type: 'date', required: true },
    draft: { type: 'boolean', default: false },
    tags: { type: 'list', of: { type: 'string' } }
  },
  computedFields: {
    slug: { type: 'string', resolve: doc => doc._raw.flattenedPath },
    words: { type: 'number', resolve: doc => doc.title.split(' ').length }
  }
}))
export default makeSource({ contentDirPath: 'content', documentTypes: [Post] })
`

const VELITE = `
import { defineConfig, defineCollection, s } from 'velite'
const posts = defineCollection({
  name: 'Post',
  pattern: '**/*.md',
  schema: s.object({ title: s.string(), date: s.isodate(), tags: s.array(s.string()).optional() })
})
export default defineConfig({ root: 'content', collections: { posts } })
`

const CONTENT_COLLECTIONS = `
import { defineCollection, defineConfig } from '@content-collections/core'
import { z } from 'zod'
const posts = defineCollection({
  name: 'posts',
  directory: 'content',
  include: '**/*.md',
  schema: z.object({ title: z.string(), date: z.coerce.date(), tags: z.array(z.string()).optional() }),
  transform: (doc) => ({ ...doc, slug: doc._meta.path })
})
export default defineConfig({ collections: [posts] })
`

// Everything here once produced a config that did not compile: a name that is
// not an identifier, two types that pluralise alike, a collection defined
// inline in the array, and a field colliding with the implicit body.
const ADVERSARIAL = `
import { defineDocumentType, makeSource } from 'contentlayer2/source-files'
const A = defineDocumentType(() => ({
  name: 'Post', filePathPattern: '*.md', contentType: 'data',
  fields: { title: { type: 'string', required: true }, content: { type: 'string' } }
}))
const B = defineDocumentType(() => ({
  name: 'Post', filePathPattern: 'other/*.md', contentType: 'data', fields: {}
}))
export default makeSource({ contentDirPath: 'content', documentTypes: [A, B] })
`

const CASES = [
  ['contentlayer2', CONTENTLAYER],
  ['velite', VELITE],
  ['content-collections', CONTENT_COLLECTIONS],
  ['contentlayer2 (adversarial)', ADVERSARIAL]
]

const count = s => s.match(/\d+ document/)?.[0] ?? 'output'

for (const [tool, source] of CASES) {
  const root = await mkdtemp(join(repo, '.migrate-'))
  try {
    await mkdir(join(root, 'content'), { recursive: true })
    await link(root)
    await writeFile(
      join(root, 'content/hello.md'),
      '---\ntitle: Hello\ndate: 2026-01-01\ntags: [a, b]\n---\n\nSome body text here.\n'
    )

    const { config, notes } = migrate(source, tool.replace(/ .*/, ''))
    await writeFile(join(root, 'contentmap.config.ts'), config)

    const built = build(root)
    if (built.status === 0) {
      console.log(
        `PASS  ${tool}: migrated config built ${count(built.stdout)} (${notes.length} notes)`
      )
    } else {
      failures++
      console.log(`FAIL  ${tool}: the migrated config did not build`)
      console.log(built.stdout.trim())
      console.log(built.stderr.trim())
      console.log('--- generated ---')
      console.log(config)
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

// Every fixture the unit tests read, built for real. The codemod's own CLI
// writes the config — the path a user actually takes — and the documents
// contentmap produces are compared with the fixture's expected.json. The unit
// tests pin the text; this proves the text produces the right data.
const { createBuilder } = await import(
  pathToFileURL(join(repo, 'packages/contentmap/dist/index.js')).href
)
const fromMdx = createRequire(join(repo, 'packages/mdx/package.json'))
const { run } = await import(pathToFileURL(fromMdx.resolve('@mdx-js/mdx')).href)

/** The three functions a compiled MDX body needs from a JSX runtime. */
const runtime = {
  Fragment: 'fragment',
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props })
}

const show = value =>
  value instanceof Date ? `Date(${value.toISOString()})` : (JSON.stringify(value) ?? String(value))

/**
 * Compare a document against what the fixture expects.
 *
 * Partial on objects — only the listed fields are checked — and exact on
 * arrays and scalars. A few matchers cover what JSON cannot say:
 * `{ "$date": iso }`, `{ "$contains": text | text[] }`, `{ "$type": name }`,
 * and `{ "$mdx": text[] }`, which renders compiled MDX both the way `run()`
 * does and the way mdx-bundler's `getMDXComponent` does, and requires them to
 * agree — that second way is how a contentlayer page renders `body.code`.
 */
async function check(actual, expected, path, problems) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      problems.push(`${path}: expected ${expected.length} items, got ${show(actual)}`)
      return
    }
    for (let i = 0; i < expected.length; i++) {
      await check(actual[i], expected[i], `${path}[${i}]`, problems)
    }
    return
  }
  if (expected === null || typeof expected !== 'object') {
    if (!Object.is(actual, expected)) {
      problems.push(`${path}: expected ${show(expected)}, got ${show(actual)}`)
    }
    return
  }
  if ('$date' in expected) {
    if (!(actual instanceof Date) || actual.toISOString() !== expected.$date) {
      problems.push(`${path}: expected Date(${expected.$date}), got ${show(actual)}`)
    }
    return
  }
  if ('$type' in expected) {
    if (typeof actual !== expected.$type) {
      problems.push(`${path}: expected a ${expected.$type}, got ${show(actual)}`)
    }
    return
  }
  if ('$contains' in expected) {
    for (const part of [expected.$contains].flat()) {
      if (typeof actual !== 'string' || !actual.includes(part)) {
        problems.push(`${path}: expected to contain ${show(part)}, got ${show(actual)}`)
      }
    }
    return
  }
  if ('$mdx' in expected) {
    if (typeof actual !== 'string') {
      problems.push(`${path}: expected compiled MDX, got ${show(actual)}`)
      return
    }
    const viaRun = await run(actual, { ...runtime, baseUrl: pathToFileURL(repo).href })
    const viaBundler = new Function('React', 'ReactDOM', '_jsx_runtime', actual)({}, {}, runtime)
    const rendered = JSON.stringify(viaRun.default({}))
    if (JSON.stringify(viaBundler.default({})) !== rendered) {
      problems.push(`${path}: renders differently under run() and getMDXComponent`)
    }
    for (const part of expected.$mdx) {
      if (!rendered.includes(part)) problems.push(`${path}: rendered output lacks ${show(part)}`)
    }
    return
  }
  if (actual === null || typeof actual !== 'object') {
    problems.push(`${path}: expected an object, got ${show(actual)}`)
    return
  }
  for (const [key, value] of Object.entries(expected)) {
    await check(actual[key], value, `${path}.${key}`, problems)
  }
}

const fixtures = join(repo, 'packages/migrate/test/fixtures')
for (const name of (await readdir(fixtures)).sort()) {
  const source = join(fixtures, name)
  if (!existsSync(join(source, 'expected.json'))) continue
  const root = await mkdtemp(join(repo, '.migrate-fixture-'))
  const generated = () =>
    readFile(join(root, 'contentmap.config.ts'), 'utf8').catch(() => '(not written)')
  try {
    await cp(source, root, { recursive: true })
    await link(root)

    const migrated = spawnSync(
      process.execPath,
      [join(repo, 'packages/migrate/dist/cli.js'), '--root', root],
      { encoding: 'utf8' }
    )
    if (migrated.status !== 0) {
      failures++
      console.log(`FAIL  fixture ${name}: the codemod failed`)
      console.log(migrated.stdout.trim())
      console.log(migrated.stderr.trim())
      continue
    }

    const built = build(root)
    if (built.status !== 0) {
      failures++
      console.log(`FAIL  fixture ${name}: the migrated config did not build`)
      console.log(built.stdout.trim())
      console.log(built.stderr.trim())
      console.log('--- generated ---')
      console.log(await generated())
      continue
    }

    const expected = JSON.parse(await readFile(join(source, 'expected.json'), 'utf8'))
    const builder = createBuilder({ root })
    await builder.build()
    const problems = []
    for (const [collection, documents] of Object.entries(expected)) {
      const byId = new Map(builder.documentsOf(collection).map(doc => [doc._meta.id, doc]))
      for (const [id, fields] of Object.entries(documents)) {
        if (id === '$missing') {
          for (const absent of fields) {
            if (byId.has(absent))
              problems.push(`${collection}/${absent} was built and should not have been`)
          }
          continue
        }
        const doc = byId.get(id)
        if (!doc) {
          problems.push(
            `${collection}/${id} is missing; built: ${[...byId.keys()].join(', ') || 'nothing'}`
          )
          continue
        }
        await check(doc, fields, `${collection}/${id}`, problems)
      }
    }

    if (problems.length === 0) {
      console.log(`PASS  fixture ${name}`)
    } else {
      failures++
      console.log(`FAIL  fixture ${name}`)
      for (const problem of problems) console.log(`      ${problem}`)
      console.log('--- generated ---')
      console.log(await generated())
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

// The CLI has to work through a bin symlink, which is the only way anyone
// actually invokes it. `@contentmap/migrate@0.1.0` shipped an entrypoint
// guarded on `import.meta.url === file://${process.argv[1]}`; npm links a bin
// as a symlink, so argv[1] is the link and import.meta.url is the target. They
// never match and `npx @contentmap/migrate` printed nothing at all. Every unit
// test passed, because they call migrate() directly.
{
  const root = await mkdtemp(join(repo, '.migrate-bin-'))
  try {
    await mkdir(join(root, 'bin'), { recursive: true })
    await symlink(join(repo, 'packages/migrate/dist/cli.js'), join(root, 'bin/contentmap-migrate'))
    await writeFile(join(root, 'velite.config.ts'), VELITE)
    const out = spawnSync(join(root, 'bin/contentmap-migrate'), ['--dry-run'], {
      cwd: root,
      encoding: 'utf8'
    })
    if (out.status === 0 && out.stdout.includes('defineCollection')) {
      console.log('PASS  cli runs through a bin symlink')
    } else {
      failures++
      console.log('FAIL  cli produced nothing when invoked through its bin symlink')
      console.log(out.stdout, out.stderr)
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

process.exitCode = failures === 0 ? 0 : 1
