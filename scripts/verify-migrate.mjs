// End-to-end: migrate a config, then build the result with contentmap.
//
// The unit tests assert the generated text. Only a real build proves the text
// is a config — that the fields exist, the transform runs, and the rewritten
// context references resolve to something.
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { migrate } from '../packages/migrate/src/index.ts'

const repo = resolve(import.meta.dirname, '..')

const CONTENTLAYER = `
import { defineDocumentType, makeSource } from 'contentlayer2/source-files'
export const Post = defineDocumentType(() => ({
  name: 'Post',
  filePathPattern: '**/*.md',
  contentType: 'markdown',
  fields: {
    title: { type: 'string', required: true },
    date: { type: 'date', required: true },
    draft: { type: 'boolean', default: false },
    tags: { type: 'list', of: { type: 'string' } }
  },
  computedFields: {
    slug: { type: 'string', resolve: doc => doc._raw.flattenedPath },
    words: { type: 'number', resolve: doc => doc.body.raw.split(' ').length }
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
  name: 'Post', filePathPattern: '*.md',
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

let failures = 0
for (const [tool, source] of CASES) {
  const root = await mkdtemp(join(repo, '.migrate-'))
  try {
    await mkdir(join(root, 'content'), { recursive: true })
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await symlink(join(repo, 'packages/contentmap'), join(root, 'node_modules/contentmap'), 'dir')
    await symlink(join(repo, 'node_modules/zod'), join(root, 'node_modules/zod'), 'dir')
    await writeFile(
      join(root, 'content/hello.md'),
      '---\ntitle: Hello\ndate: 2026-01-01\ntags: [a, b]\n---\n\nSome body text here.\n'
    )

    const { config, notes } = migrate(source, tool.replace(/ .*/, ''))
    await writeFile(join(root, 'contentmap.config.ts'), config)

    const build = spawnSync(
      process.execPath,
      [join(repo, 'packages/contentmap/dist/cli.js'), 'build'],
      {
        cwd: root,
        encoding: 'utf8'
      }
    )

    if (build.status === 0) {
      console.log(
        `PASS  ${tool}: migrated config built ${count(build.stdout)} (${notes.length} notes)`
      )
    } else {
      failures++
      console.log(`FAIL  ${tool}: the migrated config did not build`)
      console.log(build.stdout.trim())
      console.log(build.stderr.trim())
      console.log('--- generated ---')
      console.log(config)
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

process.exitCode = failures === 0 ? 0 : 1
