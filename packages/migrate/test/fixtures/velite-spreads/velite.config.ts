import { defineCollection, defineConfig, s } from 'velite'

// A schema fragment shared between fields, which has to arrive as zod.
const tag = s.string().max(20)
const meta = { tags: s.array(tag).optional() }

const posts = defineCollection({
  name: 'Post',
  pattern: 'posts/**/*.md',
  schema: s.object({ ...meta, title: s.string() })
})

const notes = defineCollection({
  name: 'Note',
  pattern: 'notes/**/*.md',
  schema: s.object({ title: s.string() })
})

const rest = { notes }

export default defineConfig({ root: 'content', collections: { posts, ...rest } })
