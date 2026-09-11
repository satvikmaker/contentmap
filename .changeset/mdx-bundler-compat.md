---
'@contentmap/mdx': minor
---

`mdx({ compat: 'mdx-bundler' })` makes compiled MDX run under mdx-bundler's `getMDXComponent` as well as under `run()`. contentlayer and content-collections pages render `body.code` that way — `useMDXComponent` from next-contentlayer, pliny's `MDXLayoutRenderer` — so a migrated site keeps rendering without a single page changing.
