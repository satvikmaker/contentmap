import { posts } from 'contentmap/generated'

// Reads the index only. The bodies live in per-document modules that this
// never imports, so the bundler has no reason to include them.
const cards = posts.select('title', 'slug').sortBy('date', 'desc').all()
console.log(cards.map(p => `${p.slug}: ${p.title}`).join('\n'))
