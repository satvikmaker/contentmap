# @contentmap/mdx

MDX for [contentmap](https://github.com/satvikmaker/contentmap), built on [@mdx-js/mdx](https://mdxjs.com).

Write JSX in your content, import components into it, export values from it — and keep contentmap's typed schema, per-document output and incremental cache.

## Install

```sh
npm i @contentmap/mdx
```

## Use

```ts
import { defineCollection, defineConfig } from 'contentmap'
import { mdx } from '@contentmap/mdx'
import { z } from 'zod'

const posts = defineCollection({
  directory: 'content/posts',
  include: '**/*.mdx',
  schema: z.object({ title: z.string(), content: z.string() }),
  transform: async (doc, ctx) => ({ ...doc, code: await ctx.mdx() })
})

export default defineConfig({ mdx: mdx(), collections: { posts } })
```

Then render it with your framework's JSX runtime:

```tsx
import { run } from '@mdx-js/mdx'
import * as runtime from 'react/jsx-runtime'
import { posts } from 'contentmap/generated'

const post = await posts.load('hello-world')
const { default: Content } = await run(post.code, { ...runtime, baseUrl: import.meta.url })

// Anything the document exported is on the same object.
// Map your own components with <Content components={{ Callout }} />
```

## What `ctx.mdx()` returns

A **JavaScript function body**, not a component — because a build can only write data, and a component does not exist until a JSX runtime has evaluated it. The string goes into your document like any other field, and `run()` turns it into a component.

This is what every tool in this space does: contentlayer's `body.code`, velite's `s.mdx()` and `@content-collections/mdx` all produce the same function-body string. `run()` evaluates JavaScript, so it will not work under a CSP that forbids `eval`.

**contentmap's own runtime is unaffected** — it still contains no `eval`, no `Function` and no `Proxy`.

## What it costs

Measured from a packed tarball:

|                    | packages | install size |
| ------------------ | -------- | ------------ |
| `contentmap` + zod | 10       | 7.0 MB       |
| `@contentmap/mdx`  | 114      | 12 MB        |

The MDX toolchain is most of a unified pipeline, and there is no version of it that is small. That is exactly why it is a separate package: a project rendering `.md` never installs any of it, and contentmap's own figures do not move.

**None of that reaches your users.** The compiler runs at build time. `import { run } from '@mdx-js/mdx'` in client code tree-shakes to **0.2 KB minified and gzipped** — measured by bundling exactly that import — because `run` is a few lines around `AsyncFunction` and pulls none of the compiler with it.

## Options

```ts
mdx({
  remarkPlugins: [remarkGfm],
  rehypePlugins: [rehypeSlug],
  recmaPlugins: [],
  development: process.env.NODE_ENV !== 'production'
})
```

`development: true` adds source positions, so a runtime error points at the `.mdx` file rather than at generated code.

Options can also be passed per call — `ctx.mdx({ remarkPlugins: [...] })` — which overrides the configured ones for that document.

## Errors

A document that will not parse fails the build and names the file:

```
✖ contentmap — 1 error in 1 document

  Transform (1)
  └─ broken.mdx
     Expected a closing tag for `<Unclosed>` (1:1-1:11)
```

## Just markdown?

Use [@contentmap/markdown](https://github.com/satvikmaker/contentmap/tree/main/packages/markdown) instead. It is far smaller, and `.md` files do not need a JSX pipeline.

## Links

- [contentmap documentation](https://github.com/satvikmaker/contentmap#readme)
- [Report an issue](https://github.com/satvikmaker/contentmap/issues)

MIT
