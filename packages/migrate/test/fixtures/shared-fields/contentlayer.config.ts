import { defineDocumentType, makeSource } from 'contentlayer2/source-files'

const title = { type: 'string', required: true } as const
const summary = { type: 'string' } satisfies Record<string, unknown>

// Spread into several types in real configs. A spread used to be invisible,
// so these fields vanished from the schema and every value became unknown.
const common = {
  title,
  draft: { type: 'boolean', default: false }
}

export const Note = defineDocumentType(() => ({
  name: 'Note',
  filePathPattern: '**/*.md',
  fields: {
    ...common,
    summary
  }
}))

export default makeSource({ contentDirPath: 'content', documentTypes: [Note] })
