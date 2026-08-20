# @contentmap/astro

An [Astro](https://astro.build) content-layer loader backed by [contentmap](https://github.com/contentmap/contentmap).

Astro 5 ships its own content layer. This package plugs contentmap into it as a loader, so you keep Astro's `getCollection()` API while contentmap does the parsing, validation and transforms — which means the same config and the same typed output as every other framework you target.

## Install

```sh
npm i @contentmap/astro
```

## Use

```ts
// src/content.config.ts
import { defineCollection } from 'astro:content'
import { contentmapLoader } from '@contentmap/astro'

export const collections = {
  posts: defineCollection({
    loader: contentmapLoader({ collection: 'posts' })
  })
}
```

```astro
---
import { getCollection } from 'astro:content'
const posts = await getCollection('posts')
---
```

Astro's dev server reloads when content changes.

## Why use this rather than Astro's own loaders

Astro's built-in `glob()` loader is good. Use this one when you want a single content definition shared across more than one framework, or when you want contentmap's transforms, cross-collection references and asset pipeline behind Astro's API.

## Options

`collection` names the contentmap collection to expose. Every [`BuilderOptions`](https://github.com/contentmap/contentmap#configuration) field is also accepted.

## Links

- [contentmap documentation](https://github.com/contentmap/contentmap#readme)
- [Report an issue](https://github.com/contentmap/contentmap/issues)

MIT
