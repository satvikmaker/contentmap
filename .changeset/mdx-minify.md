---
'@contentmap/mdx': minor
---

New `minify` option: `mdx({ minify: true })` runs the compiled output through esbuild.

Nothing reads that JavaScript — it is written to disk and handed to a bundler — and unminified it is roughly 2.5× the size. Migrating [neobrutalism-components](https://github.com/ekmas/neobrutalism-components), one page compiled to 52,316 characters here against 20,693 from Velite, which has always minified, and the 54-document corpus wrote 7.69 MB against 3.04 MB. With the option on it writes 3.30 MB and every one of the 53 prerendered pages still renders identically.

esbuild is an **optional peer**, the same bargain `@contentmap/unified` makes for `rehype-raw`: leave the option off and nothing about your install changes. It composes with `compat: 'mdx-bundler'`, which is minified along with the wrapper.
