---
title: Hello world
date: 2026-01-01
---

Your first document. Run `contentmap build`, then import it:

```ts
import { posts } from 'contentmap/generated'

const recent = posts.select('title', 'slug').sortBy('date', 'desc').limit(5).all()
```
