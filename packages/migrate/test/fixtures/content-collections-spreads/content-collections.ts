import { defineCollection, defineConfig } from '@content-collections/core'
import { z } from 'zod'
import { wordCount } from './lib/words.mjs'

// Shared by both collections, and lifted verbatim — so it has to come along.
const base = z.object({ title: z.string() })

const posts = defineCollection({
  name: 'posts',
  directory: 'content/posts',
  include: '**/*.md',
  schema: base,
  transform: doc => ({ ...doc, slug: doc._meta.path, words: wordCount(doc.title) })
})

const pages = defineCollection({
  name: 'pages',
  directory: 'content/pages',
  include: '**/*.md',
  schema: base
})

const rest = [pages]

export default defineConfig({ collections: [posts, ...rest] })
