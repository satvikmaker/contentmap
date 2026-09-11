import { defineDocumentType, makeSource, type ComputedFields } from 'contentlayer2/source-files'

// Declared once and shared by both document types, which is how most real
// configs do it. Reading only `key: value` members dropped every one of these.
const computedFields: ComputedFields = {
  slug: { type: 'string', resolve: doc => doc._raw.flattenedPath.replace(/^.+?\//, '') },
  path: { type: 'string', resolve: doc => doc._raw.flattenedPath }
}

export const Post = defineDocumentType(() => ({
  name: 'Post',
  filePathPattern: 'posts/**/*.md',
  fields: {
    title: { type: 'string', required: true }
  },
  computedFields: {
    ...computedFields,
    url: { type: 'string', resolve: doc => `/blog/${doc._raw.flattenedPath}` }
  }
}))

export const Page = defineDocumentType(() => ({
  name: 'Page',
  filePathPattern: 'pages/**/*.md',
  fields: {
    title: { type: 'string', required: true }
  },
  computedFields
}))

export default makeSource({ contentDirPath: 'content', documentTypes: [Post, Page] })
