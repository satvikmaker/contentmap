import { defineCollection, defineConfig } from 'contentmap'
import { z } from 'zod'

const posts = defineCollection({
  name: 'posts',
  directory: 'content/posts',
  include: '**/*.md',
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    draft: z.boolean().default(false)
  }),
  transform: (doc, ctx) => ({
    ...doc,
    slug: ctx.meta.slug
  })
})

export default defineConfig({
  collections: { posts }
})
