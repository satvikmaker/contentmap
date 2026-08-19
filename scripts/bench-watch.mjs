// What a watch-mode rebuild costs when the watcher tells us exactly what moved.
//
// A cold `build()` must re-glob and re-stat the corpus because it cannot know
// what changed. Watch mode does know, which removes the stat pass entirely.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadavg, availableParallelism } from 'node:os'
import { createBuilder } from '../packages/contentmap/dist/index.js'

const N = Number(process.argv[2] ?? 10_000)
const root = await mkdtemp(join(process.cwd(), '.wb-'))
try {
  await mkdir(join(root, 'content'), { recursive: true })
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      writeFile(join(root, `content/p${i}.md`), `---\ntitle: P${i}\n---\n\nbody ${i}\n`)
    )
  )
  await writeFile(
    join(root, 'contentmap.config.ts'),
    `import { defineConfig, defineCollection } from '${process.cwd()}/packages/contentmap/src/index.ts'\n` +
      `import { z } from 'zod'\n` +
      `const posts = defineCollection({ name: 'posts', directory: 'content', include: '**/*.md', schema: z.object({ title: z.string() }) })\n` +
      `export default defineConfig({ collections: { posts } })\n`
  )

  const b = createBuilder({ root })
  await b.build()

  let watched = Infinity
  let blind = Infinity
  let watchedRead = Infinity
  let blindRead = Infinity
  for (let i = 0; i < 5; i++) {
    await writeFile(join(root, `content/p${i}.md`), `---\ntitle: Watched ${i}\n---\n\nbody\n`)
    let t = performance.now()
    await b.build({ changed: new Set([`p${i}.md`]) })
    watched = Math.min(watched, performance.now() - t)
    watchedRead = Math.min(watchedRead, b.phases['read'] ?? Infinity)

    await writeFile(join(root, `content/p${i}.md`), `---\ntitle: Blind ${i}\n---\n\nbody\n`)
    t = performance.now()
    await b.build()
    blind = Math.min(blind, performance.now() - t)
    blindRead = Math.min(blindRead, b.phases['read'] ?? Infinity)
  }

  console.log(`corpus            ${N.toLocaleString()} documents, best of 5`)
  console.log(`load              ${loadavg()[0].toFixed(1)} on ${availableParallelism()} cores`)
  console.log(`rescan (no hint)  ${blind.toFixed(0)}ms total, discovery ${blindRead.toFixed(0)}ms`)
  console.log(`watch (1 changed) ${watched.toFixed(0)}ms total, discovery ${watchedRead.toFixed(0)}ms`)
  console.log(`discovery saved   ${(blindRead - watchedRead).toFixed(0)}ms (the stat pass the watcher makes unnecessary)`)
  const noisy = loadavg()[0] > availableParallelism() * 0.7
  if (noisy) console.log('!  machine busy; timings unreliable')
  else console.log(`${watched < 50 ? 'PASS' : 'FAIL'}  watch rebuild < 50ms`)
  await b.close()
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
}
