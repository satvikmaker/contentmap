import { defineDocumentType, makeSource } from 'contentlayer2/source-files'

// contentlayer handed every one of these back as an ISO string. contentmap
// hands back a Date, which breaks code that treats them as strings — so each
// has to be reported, with the one-line change that keeps the string.
export const Event = defineDocumentType(() => ({
  name: 'Event',
  filePathPattern: '**/*.md',
  fields: {
    title: { type: 'string', required: true },
    date: { type: 'date', required: true },
    updated: { type: 'date' },
    reminders: { type: 'list', of: { type: 'date' } }
  }
}))

export default makeSource({ contentDirPath: 'content', documentTypes: [Event] })
