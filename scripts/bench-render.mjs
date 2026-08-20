// What does the renderer actually cost end to end?
//
// The research measured markdown parsing at ~5% of build time on a 10k corpus,
// with file reads at ~82%. If that holds, a 100x faster renderer buys a few
// percent overall — which is the difference between "worth a native binary that
// ships daily breaking releases" and "not".
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { loadavg, availableParallelism } from 'node:os'
import { join } from 'node:path'
import { createBuilder } from '../packages/contentmap/dist/index.js'
import { markdown } from '../packages/markdown/dist/index.js'
import { unifiedRenderer } from '../packages/unified/dist/index.js'

const N = Number(process.argv[2] ?? 2000)
const RUNS = 3
const root = await mkdtemp(join(process.cwd(), '.bench-'))

try {
  await mkdir(join(root, 'content'), { recursive: true })
  const body = [
    '## Section',
    '',
    'Paragraph with **bold**, `code` and [a link](https://example.com).',
    '',
    '- one',
    '- two',
    '',
    '### Nested',
    '',
    '> quote',
    ''
  ].join('\n')
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      writeFile(
        join(root, `content/p-${i}.md`),
        `---\ntitle: Post ${i}\n---\n\n# Post ${i}\n\n${body.repeat(3)}`
      )
    )
  )

  const config = (rendererImport, call) => `
import { defineConfig, defineCollection } from '${process.cwd()}/packages/contentmap/src/index.ts'
${rendererImport}
import { z } from 'zod'
const posts = defineCollection({
  name: 'posts', directory: 'content', include: '**/*.md',
  schema: z.object({ title: z.string(), content: z.string() })${
    call
      ? `,
  transform: async (doc, ctx) => ({ title: doc.title, html: await ctx.markdown(), reading: await ctx.readingTime() })`
      : ''
  }
})
export default defineConfig({ collections: { posts }${call ? `, renderer: ${call}` : ''} })
`

  const CASES = [
    ['no renderer  ', config('', null), undefined],
    [
      'marked       ',
      config(
        `import { markdown } from '${process.cwd()}/packages/markdown/src/index.ts'`,
        'markdown()'
      ),
      markdown()
    ],
    [
      'unified      ',
      config(
        `import { unifiedRenderer } from '${process.cwd()}/packages/unified/src/index.ts'`,
        'unifiedRenderer()'
      ),
      unifiedRenderer()
    ]
  ]

  console.log(`corpus  ${N.toLocaleString()} markdown documents, best of ${RUNS}`)
  console.log(`load    ${loadavg()[0].toFixed(1)} on ${availableParallelism()} cores\n`)

  const results = []
  for (const [label, cfg] of CASES) {
    await writeFile(join(root, 'contentmap.config.ts'), cfg)
    let best = Infinity
    let phases = {}
    for (let i = 0; i < RUNS; i++) {
      await rm(join(root, '.contentmap'), { recursive: true, force: true })
      const b = createBuilder({ root })
      const t = performance.now()
      const r = await b.build()
      const ms = performance.now() - t
      if (r.errors) throw new Error(`${label}: ${r.errors} errors`)
      if (ms < best) {
        best = ms
        phases = Object.fromEntries(Object.entries(b.phases).map(([k, v]) => [k, Math.round(v)]))
      }
    }
    results.push([label, best, phases])
  }

  const load = loadavg()[0]
  if (load > availableParallelism() * 0.7) {
    console.log('!  machine is busy — total timings are unreliable.')
    console.log('!  The parse+validate phase still isolates the renderer: same code path,')
    console.log('!  same run, only the renderer differs.\n')
  }

  const base = results[0][1]
  for (const [label, ms, phases] of results) {
    const delta = ms === base ? '' : `  (+${Math.round(ms - base)}ms vs no renderer)`
    console.log(`${label} ${ms.toFixed(0).padStart(6)}ms${delta}`)
    console.log(`               phases ${JSON.stringify(phases)}`)
  }

  const markedCost = results[1][1] - base
  const unifiedCost = results[2][1] - base
  console.log(
    `\nrendering share of build: marked ${((markedCost / results[1][1]) * 100).toFixed(1)}%, unified ${((unifiedCost / results[2][1]) * 100).toFixed(1)}%`
  )
  console.log(
    `a hypothetical 100x-faster renderer would save at most ${Math.round(markedCost)}ms of ${Math.round(results[1][1])}ms`
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
