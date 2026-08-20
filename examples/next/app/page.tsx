import { posts } from 'contentmap/generated'

// Reads the index only. Bodies live in per-document modules this never imports.
export default function Home() {
  const cards = posts.select('title', 'slug').sortBy('date', 'desc').all()
  return (
    <main>
      <h1>Posts</h1>
      <ul>
        {cards.map(post => (
          <li key={post.slug} data-slug={post.slug}>
            {post.title}
          </li>
        ))}
      </ul>
    </main>
  )
}
