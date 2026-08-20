import { defineCollection } from 'astro:content'
import { contentmapLoader } from '@contentmap/astro'

export const collections = {
  posts: defineCollection({ loader: contentmapLoader({ collection: 'posts' }) })
}
