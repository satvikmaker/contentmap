// Type-check a user-shaped project against the BUILT package.
//
// Our own type tests import `../src/*.ts`, and a user imports the emitted
// `.d.ts`. That gap is not academic: two bugs shipped through it, and both
// were found by `next build` type-checking a real project rather than by any
// test here.
//
//  - `transform` declared as a property with a function type is contravariant
//    under strictFunctionTypes, so a concrete collection stopped being
//    assignable to the erased CollectionDefinition. Every user with a
//    transform got an error inside their own config file.
//  - `sortBy` constrained to the projection rather than the index forbade
//    `select('title').sortBy('date')`, which the runtime does correctly.
//
// Runs tsc against the tsconfig Next generates, because that is the strictest
// configuration a mainstream framework imposes by default.
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repo = resolve(import.meta.dirname, '..')
const root = await mkdtemp(join(repo, '.types-'))

try {
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await mkdir(join(root, 'content/posts'), { recursive: true })
  await symlink(join(repo, 'packages/contentmap'), join(root, 'node_modules/contentmap'), 'dir')
  await symlink(join(repo, 'node_modules/zod'), join(root, 'node_modules/zod'), 'dir')

  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['dom', 'esnext'],
          strict: true,
          noEmit: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          esModuleInterop: true,
          skipLibCheck: true,
          types: [],
          paths: { 'contentmap/generated': ['./.contentmap'] }
        },
        include: ['**/*.ts']
      },
      null,
      2
    )
  )

  // Exactly what `contentmap init` writes, including the transform.
  await writeFile(
    join(root, 'contentmap.config.ts'),
    `import { defineCollection, defineConfig } from 'contentmap'\n` +
      `import { z } from 'zod'\n\n` +
      `const posts = defineCollection({\n` +
      `  name: 'posts',\n` +
      `  directory: 'content/posts',\n` +
      `  include: '**/*.md',\n` +
      `  schema: z.object({ title: z.string(), date: z.coerce.date(), content: z.string() }),\n` +
      `  transform: (doc, ctx) => ({ ...doc, slug: ctx.meta.slug })\n` +
      `})\n\n` +
      `export default defineConfig({ collections: { posts } })\n`
  )

  await writeFile(
    join(root, 'content/posts/first.md'),
    '---\ntitle: First\ndate: 2026-02-01\n---\n\nBody.\n'
  )

  const cli = join(repo, 'packages/contentmap/dist/cli.js')
  const built = spawnSync(process.execPath, [cli, 'build'], { cwd: root, encoding: 'utf8' })
  if (built.status !== 0) {
    console.log('FAIL  the fixture did not build')
    console.log(built.stdout, built.stderr)
    process.exitCode = 1
  }

  await writeFile(
    join(root, 'consumer.ts'),
    `import { posts } from 'contentmap/generated'\n\n` +
      `// Select what you render, sort and filter by something you did not.\n` +
      `export const cards = posts.select('title', 'slug').sortBy('date', 'desc').limit(5).all()\n` +
      `export const recent = posts.select('title').where({ slug: 'first' }).all()\n` +
      `export const byDate = posts.select('title').groupBy('date')\n` +
      `export const titles: string[] = cards.map(c => c.title)\n`
  )

  const tsc = spawnSync(
    process.execPath,
    [join(repo, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', join(root, 'tsconfig.json')],
    { encoding: 'utf8' }
  )

  if (tsc.status === 0) {
    console.log('PASS  a user-shaped project type-checks against the built package')
  } else {
    console.log('FAIL  a user project would not compile')
    console.log(tsc.stdout.trim())
    process.exitCode = 1
  }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
}
