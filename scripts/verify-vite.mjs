// End-to-end check: a real `vite build` with the plugin, then the same app
// built by the CLI with no plugin at all.
//
// Calling plugin hooks directly proves the hooks; only a real bundler proves
// the plugin.
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'vite'
import { contentmap } from '../packages/vite/src/index.ts'

const root = await mkdtemp(join(process.cwd(), '.vite-e2e-'))
const cwd = process.cwd()
try {
  await mkdir(join(root, 'content'), { recursive: true })
  await writeFile(join(root, 'content/hello.md'), '---\ntitle: Hello From Content\n---\nbody')
  await writeFile(join(root, 'content/second.md'), '---\ntitle: Second Doc\n---\nbody')
  await writeFile(
    join(root, 'contentmap.config.ts'),
    `import { defineConfig, defineCollection } from '${cwd}/packages/contentmap/src/index.ts'\n` +
      `import { z } from 'zod'\n` +
      `const posts = defineCollection({ name: 'posts', directory: 'content', include: '**/*.md', schema: z.object({ title: z.string() }) })\n` +
      `export default defineConfig({ collections: { posts } })\n`
  )
  await writeFile(
    join(root, 'main.js'),
    `import { posts } from 'contentmap/generated'\n` +
      `document.title = posts.select('title').all().map(p => p.title).join(', ')\n`
  )

  const result = await build({
    root,
    logLevel: 'error',
    plugins: [contentmap({ root })],
    build: {
      write: false,
      lib: { entry: join(root, 'main.js'), formats: ['es'], fileName: 'out' },
      rollupOptions: { external: [] }
    }
  })

  const output = Array.isArray(result) ? result[0].output : result.output
  const code = output.map(chunk => chunk.code ?? '').join('\n')

  const ok = code.includes('Hello From Content') && code.includes('Second Doc')
  console.log(ok ? 'PASS  vite build resolved and bundled the generated content' : 'FAIL  content missing from the bundle')
  if (!ok) {
    console.log('--- bundle head ---')
    console.log(code.slice(0, 400))
    process.exitCode = 1
  }

  const files = await readdir(join(root, '.contentmap'))
  console.log(`      generated: ${files.filter(f => f !== '.cache').join(', ')}`)
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
}
