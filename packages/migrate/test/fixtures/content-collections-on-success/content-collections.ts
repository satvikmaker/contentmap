import { defineCollection, defineConfig } from '@content-collections/core'
import { z } from 'zod'
import { mkdirSync, writeFileSync } from 'node:fs'

// Each collection has its own onSuccess, handed that collection's documents.
const posts = defineCollection({
  name: 'posts',
  directory: 'content/posts',
  include: '**/*.md',
  schema: z.object({ title: z.string() }),
  onSuccess: docs => {
    mkdirSync('generated', { recursive: true })
    writeFileSync('generated/count.txt', String(docs.length))
  }
})

const pages = defineCollection({
  name: 'pages',
  directory: 'content/pages',
  include: '**/*.md',
  schema: z.object({ title: z.string() }),
  onSuccess: async docs => {
    mkdirSync('generated', { recursive: true })
    writeFileSync('generated/pages.txt', docs.map(doc => doc.title).join(','))
  }
})

export default defineConfig({ collections: [posts, pages] })
