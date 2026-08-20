# @contentmap/markdown

The default markdown renderer for [contentmap](https://github.com/satvikmaker/contentmap), built on [marked](https://github.com/markedjs/marked).

Renderers are opt-in packages rather than core dependencies: a project rendering only JSON and YAML should not install a markdown parser, and a project that wants remark plugins should not carry marked as dead weight.

## Install

```sh
npm i @contentmap/markdown
```

## Use

Register it on the config, then call `ctx.markdown()` from a transform:

```ts
import { defineConfig, defineCollection } from 'contentmap'
import { markdown } from '@contentmap/markdown'
import { z } from 'zod'

export default defineConfig({
  renderers: [markdown()],
  collections: {
    posts: defineCollection({
      directory: 'content/posts',
      include: '**/*.md',
      schema: z.object({ title: z.string() }),
      transform: async (doc, ctx) => ({
        ...doc,
        html: await ctx.markdown()
      })
    })
  }
})
```

`ctx.markdown()` renders the document body. Pass a string to render something else.

## Options

`markdown(options)` forwards `options` to marked, so `gfm`, `breaks` and the rest behave exactly as documented upstream.

For remark and rehype plugins instead, use [@contentmap/unified](https://github.com/satvikmaker/contentmap/tree/main/packages/unified).

## Links

- [contentmap documentation](https://github.com/satvikmaker/contentmap#readme)
- [Report an issue](https://github.com/satvikmaker/contentmap/issues)

MIT
