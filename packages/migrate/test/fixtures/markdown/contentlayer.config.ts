import { defineDocumentType, makeSource } from 'contentlayer2/source-files'
import remarkShout from './lib/remark-shout.mjs'

// No contentType: contentlayer's default is markdown, rendered with
// remark-parse and remark-rehype alone — no GFM, no heading ids.
export const Post = defineDocumentType(() => ({
  name: 'Post',
  filePathPattern: '**/*.md',
  fields: {
    title: { type: 'string', required: true }
  },
  computedFields: {
    opening: { type: 'string', resolve: doc => doc.body.raw.trim().slice(0, 5) }
  }
}))

export default makeSource({
  contentDirPath: 'content',
  documentTypes: [Post],
  markdown: { remarkPlugins: [remarkShout] }
})
