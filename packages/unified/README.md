# @contentmap/unified

A [remark](https://github.com/remarkjs/remark)/[rehype](https://github.com/rehypejs/rehype) renderer for [contentmap](https://github.com/satvikmaker/contentmap), for when you want the plugin ecosystem.

[@contentmap/markdown](https://github.com/satvikmaker/contentmap/tree/main/packages/markdown) is the lighter default. Reach for this one when you need remark or rehype plugins — footnotes, math, syntax highlighting, custom directives.

## Install

```sh
npm i @contentmap/unified
```

## Use

```ts
import { defineConfig, defineCollection } from 'contentmap'
import { unifiedRenderer } from '@contentmap/unified'
import rehypeHighlight from 'rehype-highlight'
import { z } from 'zod'

export default defineConfig({
  renderers: [unifiedRenderer({ rehypePlugins: [rehypeHighlight] })],
  collections: {
    posts: defineCollection({
      directory: 'content/posts',
      include: '**/*.md',
      schema: z.object({ title: z.string() }),
      transform: async (doc, ctx) => ({ ...doc, html: await ctx.markdown() })
    })
  }
})
```

## Defaults

GitHub Flavored Markdown (`remark-gfm`) and heading slugs (`rehype-slug`) are on by default. `remarkPlugins` and `rehypePlugins` append to those.

## Raw HTML

Raw HTML in markdown is **not** passed through by default, because doing so on untrusted content is an XSS vector. To allow it, install `rehype-raw` — an optional peer dependency — and set `allowDangerousHtml: true`:

```ts
unifiedRenderer({ allowDangerousHtml: true })
```

Only do this for content you control.

## Links

- [contentmap documentation](https://github.com/satvikmaker/contentmap#readme)
- [Report an issue](https://github.com/satvikmaker/contentmap/issues)

MIT
