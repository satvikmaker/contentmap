# @contentmap/image

Image dimensions and [thumbhash](https://github.com/evanw/thumbhash) placeholders for [contentmap](https://github.com/contentmap/contentmap).

Reading dimensions at build time is what lets you set `width` and `height` on every `<img>`, which is the difference between a page that settles and a page that jumps while it loads.

## Install

```sh
npm i @contentmap/image
```

## Use

```ts
import { defineConfig, defineCollection } from 'contentmap'
import { image } from '@contentmap/image'
import { z } from 'zod'

export default defineConfig({
  image: image(),
  collections: {
    posts: defineCollection({
      directory: 'content/posts',
      include: '**/*.md',
      schema: z.object({ title: z.string(), cover: z.string() }),
      transform: async (doc, ctx) => ({
        ...doc,
        cover: await ctx.image(doc.cover)
      })
    })
  }
})
```

`ctx.image()` copies the file into the output, hashes the name for cache-busting, and returns:

```ts
{
  src: '/assets/cover.a1b2c3.png',
  size: 48123,
  width: 1200,
  height: 630,
  format: 'png',
  aspectRatio: 1.905,
  placeholder: 'data:image/png;base64,…'
}
```

## Placeholders

Dimensions come from [image-size](https://github.com/image-size/image-size), which reads headers only — it does not decode the image.

Placeholders need pixels, so they require [sharp](https://sharp.pixelplumbing.com), an **optional** dependency. Without sharp installed you still get `src`, `size`, `width`, `height`, `format` and `aspectRatio`; `placeholder` is simply absent. Install sharp to enable it:

```sh
npm i sharp
```

A thumbhash placeholder is a 21-byte payload that expands to a recognisable blur of the image, and ships as a data URL with no client-side JavaScript.

## Links

- [contentmap documentation](https://github.com/contentmap/contentmap#readme)
- [Report an issue](https://github.com/contentmap/contentmap/issues)

MIT
