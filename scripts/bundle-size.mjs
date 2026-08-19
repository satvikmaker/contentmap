// What does a page that renders 10 cards from a large collection actually ship?
// content-collections' single-array output makes the answer "the whole corpus":
// reading one title from 5,000 posts bundles 17,141,241 bytes.
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { rolldown } from 'rolldown'
import { createBuilder } from '../packages/contentmap/dist/index.js'

const N = 5000
const root = await mkdtemp(join(process.cwd(), '.bundle-'))
try {
  await mkdir(join(root, 'content'), { recursive: true })
  const body = 'Real prose paragraph for a realistic body size.\n\n'.repeat(30)
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      writeFile(
        join(root, `content/post-${i}.md`),
        `---\ntitle: Post number ${i}\ndate: 2026-01-${(i % 28) + 1}\ndraft: false\n---\n\n${body}`
      )
    )
  )
  await writeFile(
    join(root, 'contentmap.config.ts'),
    `import { defineConfig, defineCollection } from '${process.cwd()}/packages/contentmap/src/index.ts'\n` +
      `import { z } from 'zod'\n` +
      `const posts = defineCollection({ name: 'posts', directory: 'content', include: '**/*.md',\n` +
      `  schema: z.object({ title: z.string(), date: z.coerce.date(), draft: z.boolean(), content: z.string() }) })\n` +
      `export default defineConfig({ collections: { posts } })\n`
  )
  const r = await createBuilder({ root }).build()
  if (r.errors) throw new Error('build failed')

  const corpus = (await Promise.all(
    Array.from({ length: N }, (_, i) => readFile(join(root, `content/post-${i}.md`)))
  )).reduce((n, b) => n + b.length, 0)

  await writeFile(
    join(root, 'app.js'),
    `import { posts } from './.contentmap/posts/index.js'\n` +
      `const cards = posts.where({ draft: false }).select('title').sortBy('title').limit(10).all()\n` +
      `console.log(cards.map(c => c.title).join())\n`
  )

  const bundle = await rolldown({
    input: join(root, 'app.js'),
    external: ['contentmap/runtime'],
    onwarn: () => {}
  })
  const { output } = await bundle.generate({ format: 'esm' })
  const bytes = Buffer.byteLength(output[0].code)
  const gz = gzipSync(output[0].code).length

  const kb = n => `${(n / 1024).toFixed(1)} KB`
  console.log(`corpus on disk        ${kb(corpus)}  (${N.toLocaleString()} documents)`)
  console.log(`bundled for 10 cards  ${kb(bytes)}  (${kb(gz)} gzip)`)
  console.log(`ratio                 ${(bytes / corpus * 100).toFixed(1)}% of corpus`)
  console.log(`content-collections   16,739.5 KB for the same read (measured, issue #784 shape)`)
} finally {
  await rm(root, { recursive: true, force: true })
}
