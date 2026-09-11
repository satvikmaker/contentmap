import { defineDocumentType, makeSource } from 'contentlayer2/source-files'
import remarkShout from './lib/remark-shout.mjs'
import rehypeMark from './lib/rehype-mark.mjs'

export const Post = defineDocumentType(() => ({
  name: 'Post',
  filePathPattern: '**/*.mdx',
  contentType: 'mdx',
  fields: {
    title: { type: 'string', required: true }
  },
  computedFields: {
    compiled: { type: 'boolean', resolve: doc => doc.body.code.length > 0 }
  }
}))

export default makeSource({
  contentDirPath: 'content',
  documentTypes: [Post],
  mdx: {
    cwd: process.cwd(),
    remarkPlugins: [remarkShout],
    rehypePlugins: [[rehypeMark, { className: 'marked' }]]
  }
})
