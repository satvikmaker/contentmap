import { defineDocumentType, makeSource } from 'contentlayer2/source-files'

// contentlayer exports allAuthors, allPeople, allCategories, allSeries and
// allPosts for these. A hand-rolled plural produced `authorses`.
const named = { name: { type: 'string', required: true } } as const

export const Authors = defineDocumentType(() => ({
  name: 'Authors',
  filePathPattern: 'authors/*.yaml',
  contentType: 'data',
  fields: named
}))

export const Person = defineDocumentType(() => ({
  name: 'Person',
  filePathPattern: 'people/*.yaml',
  contentType: 'data',
  fields: named
}))

export const Category = defineDocumentType(() => ({
  name: 'Category',
  filePathPattern: 'categories/*.yaml',
  contentType: 'data',
  fields: named
}))

export const Series = defineDocumentType(() => ({
  name: 'Series',
  filePathPattern: 'series/*.yaml',
  contentType: 'data',
  fields: named
}))

export const Post = defineDocumentType(() => ({
  name: 'Post',
  filePathPattern: 'posts/*.yaml',
  contentType: 'data',
  fields: named
}))

export default makeSource({
  contentDirPath: 'content',
  documentTypes: [Authors, Person, Category, Series, Post]
})
