import { defineDocumentType, makeSource } from 'contentlayer2/source-files'
import { sharedFields } from './lib/shared.mjs'

const makeComputed = () => ({
  slug: { type: 'string', resolve: doc => doc._raw.flattenedPath }
})
const key = 'dynamic'

// None of the first three can be followed without running the code. Each has
// to be named in the report: dropping them quietly is the one outcome a
// migration must never have.
export const Post = defineDocumentType(() => ({
  name: 'Post',
  filePathPattern: '**/*.md',
  fields: {
    ...sharedFields,
    title: { type: 'string', required: true }
  },
  computedFields: {
    ...makeComputed(),
    [key]: { type: 'string', resolve: () => 'x' },
    kept: { type: 'string', resolve: doc => doc.title }
  }
}))

export default makeSource({ contentDirPath: 'content', documentTypes: [Post] })
