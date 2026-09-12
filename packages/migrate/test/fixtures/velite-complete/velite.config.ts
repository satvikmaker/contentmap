import { defineCollection, defineConfig, s } from 'velite'
import { mkdir, writeFile } from 'node:fs/promises'

const posts = defineCollection({
  name: 'Post',
  pattern: 'posts/**/*.md',
  schema: s.object({ title: s.string() })
})

export default defineConfig({
  root: 'content',
  collections: { posts },
  // Maps onto contentmap's output field for field, the [hash:6] token
  // included. `data` is left at the default so this fixture's documents stay
  // where the verifier looks for them.
  output: {
    assets: 'public/static',
    base: '/static/',
    name: '[name]-[hash:6].[ext]',
    clean: true
  },
  // After the build, with every collection's documents.
  async complete(data) {
    await mkdir('generated', { recursive: true })
    await writeFile('generated/titles.json', JSON.stringify(data.posts.map(post => post.title)))
  },
  // Before output, changing it. contentmap has no hook there, so it is reported.
  prepare: data => {
    data.posts.push({ title: 'Injected' })
  }
})
