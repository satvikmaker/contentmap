import { defineDocumentType, makeSource } from 'contentlayer2/source-files'

export const Post = defineDocumentType(() => ({
  name: 'Post',
  filePathPattern: '**/*.md',
  fields: {
    title: { type: 'string', required: true }
  },
  computedFields: {
    // Renamed through fieldOptions: `kind` is the type, `article` the body.
    label: { type: 'string', resolve: doc => `${doc.kind}:${doc.article.raw.trim().length}` }
  }
}))

export default makeSource({
  contentDirPath: 'content',
  contentDirExclude: ['drafts'],
  documentTypes: [Post],
  fieldOptions: { bodyFieldName: 'article', typeFieldName: 'kind' },
  onMissingOrIncompatibleData: 'skip-warn',
  onExtraFieldData: 'ignore',
  disableImportAliasWarning: true,
  date: { timezone: 'Europe/Lisbon' },
  somethingElse: true
})
