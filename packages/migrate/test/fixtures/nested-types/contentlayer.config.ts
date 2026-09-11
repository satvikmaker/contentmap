import { defineDocumentType, defineNestedType, makeSource } from 'contentlayer2/source-files'

const Location = defineNestedType(() => ({
  name: 'Location',
  fields: {
    lat: { type: 'number', required: true },
    lng: { type: 'number', required: true }
  }
}))

const Image = defineNestedType(() => ({
  name: 'Image',
  fields: { src: { type: 'string', required: true } }
}))

const Video = defineNestedType(() => ({
  name: 'Video',
  fields: { url: { type: 'string', required: true } }
}))

export const Place = defineDocumentType(() => ({
  name: 'Place',
  filePathPattern: 'places/*.yaml',
  contentType: 'data',
  fields: {
    name: { type: 'string', required: true },
    location: { type: 'nested', of: Location, required: true },
    tags: { type: 'list', of: { type: 'enum', options: ['a', 'b'] } },
    stops: { type: 'list', of: Location },
    // A mixed list: contentlayer tells the members apart by `type`.
    media: { type: 'list', of: [Image, Video] }
  }
}))

export default makeSource({ contentDirPath: 'content', documentTypes: [Place] })
