import { defineDocumentType, makeSource } from 'contentlayer2/source-files'
import { mkdirSync, writeFileSync } from 'node:fs'

// Tag counts for a tags page, written after every build — the job
// tailwind-nextjs-starter-blog's onSuccess does for thousands of forks.
function countTags(posts) {
  const counts = {}
  for (const post of posts) {
    for (const tag of post.tags) counts[tag] = (counts[tag] ?? 0) + 1
  }
  return counts
}

export const Post = defineDocumentType(() => ({
  name: 'Post',
  filePathPattern: '**/*.md',
  fields: {
    title: { type: 'string', required: true },
    tags: { type: 'list', of: { type: 'string' }, default: [] }
  }
}))

export default makeSource({
  contentDirPath: 'content',
  documentTypes: [Post],
  onSuccess: async importData => {
    const { allPosts } = await importData()
    mkdirSync('generated', { recursive: true })
    writeFileSync('generated/tag-data.json', JSON.stringify(countTags(allPosts)))
  }
})
