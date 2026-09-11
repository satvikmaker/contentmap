import { defineDocumentType, makeSource } from 'contentlayer2/source-files'
import { basename } from 'node:path'
import * as nodePath from 'node:path'
import countWords from './lib/words.mjs'
import { SITE } from './lib/site.mjs'
import type { Unused } from './lib/types'

const unused: Unused | undefined = undefined

// Every link is built from this.
const base = `${SITE}/content`

function titleCase(input: string): string {
  return input.replace(/\b\w/g, c => c.toUpperCase())
}

export const Post = defineDocumentType(() => ({
  name: 'Post',
  filePathPattern: '**/*.md',
  fields: {
    title: { type: 'string', required: true }
  },
  computedFields: {
    words: { type: 'number', resolve: doc => countWords(doc.body.raw) },
    file: { type: 'string', resolve: doc => basename(doc._raw.sourceFilePath) },
    folder: { type: 'string', resolve: doc => nodePath.posix.dirname(doc._raw.sourceFilePath) },
    heading: { type: 'string', resolve: doc => titleCase(doc.title) },
    url: { type: 'string', resolve: doc => `${base}/${doc._raw.flattenedPath}` }
  }
}))

export default makeSource({ contentDirPath: 'content', documentTypes: [Post] })
