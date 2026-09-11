import { defineCollection, defineConfig } from 'contentmap'
import { z } from 'zod'

const posts = defineCollection({
  name: 'posts',
  directory: 'content/posts',
  include: '**/*.md',
  schema: z.object({ title: z.string(), date: z.coerce.date(), content: z.string() }),
  transform: (doc, ctx) => ({ ...doc, slug: ctx.meta.slug })
})

export default defineConfig({
  collections: { posts },
  // A search index, written by the framework's build exactly as by the CLI.
  // The build script checks it was regenerated.
  afterBuild: ctx =>
    ctx.writeFile(
      'public/search.json',
      JSON.stringify(ctx.documents(posts).map(({ title, slug }) => ({ title, slug })))
    )
})
