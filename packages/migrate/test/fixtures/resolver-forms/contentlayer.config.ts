import { defineDocumentType, makeSource } from 'contentlayer2/source-files'

function slugOf(doc) {
  return doc._raw.flattenedPath.split('/').pop()
}

function describe(doc) {
  return `${doc._id}:${doc.type}`
}

// Every shape a resolver comes in. The first five cannot be reduced to one
// expression, so they are called as written with a contentlayer-shaped
// document; the rest are inlined with exact rewrites.
export const Note = defineDocumentType(() => ({
  name: 'Note',
  filePathPattern: 'notes/**/*.yaml',
  contentType: 'data',
  fields: {
    title: { type: 'string', required: true }
  },
  computedFields: {
    block: {
      type: 'string',
      resolve: doc => {
        const path = doc._raw.flattenedPath
        return path.toUpperCase()
      }
    },
    method: {
      type: 'string',
      resolve(doc) {
        return doc._raw.sourceFileName
      }
    },
    named: { type: 'string', resolve: slugOf },
    destructured: {
      type: 'string',
      resolve: ({ title, _raw }) => `${title}@${_raw.flattenedPath}`
    },
    whole: { type: 'string', resolve: doc => describe(doc) },
    later: { type: 'string', resolve: async doc => (await Promise.resolve(doc.title)).toLowerCase() },
    kind: { type: 'string', resolve: doc => doc.type },
    id: { type: 'string', resolve: doc => doc._id },
    folder: { type: 'string', resolve: doc => doc._raw.sourceFileDir }
  }
}))

export default makeSource({ contentDirPath: 'content', documentTypes: [Note] })
