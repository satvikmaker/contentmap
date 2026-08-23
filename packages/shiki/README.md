# @contentmap/shiki

Syntax highlighting for [contentmap](https://github.com/satvikmaker/contentmap), built on [Shiki](https://shiki.style).

Shiki uses the same TextMate grammars and themes VS Code does, so a code block looks the way it looks in your editor — and it runs at build time, so the browser gets coloured HTML and no highlighter.

## Install

```sh
npm i @contentmap/shiki
```

## Use

```ts
import { defineCollection, defineConfig } from 'contentmap'
import { markdown } from '@contentmap/markdown'
import { shiki } from '@contentmap/shiki'
import { z } from 'zod'

const posts = defineCollection({
  directory: 'content/posts',
  include: '**/*.md',
  schema: z.object({ title: z.string(), content: z.string() }),
  transform: async (doc, ctx) => ({ ...doc, html: await ctx.markdown() })
})

export default defineConfig({
  renderer: markdown({ extensions: [await shiki({ theme: 'github-dark' })] }),
  collections: { posts }
})
```

It is a marked extension, so it goes through the renderer's existing `extensions` option and neither package needs to know about the other.

`shiki()` is async because Shiki loads grammars up front. That is what makes highlighting itself synchronous, which is what lets it sit inside marked's pipeline at all.

## Light and dark

```ts
await shiki({ theme: { light: 'github-light', dark: 'github-dark' } })
```

Emits CSS variables instead of inline colours, so the page can switch themes without re-highlighting — something a build-time highlighter otherwise cannot do, having already committed to one palette. Add the matching CSS:

```css
@media (prefers-color-scheme: dark) {
  .shiki,
  .shiki span {
    color: var(--shiki-dark) !important;
    background-color: var(--shiki-dark-bg) !important;
  }
}
```

## Languages

```ts
await shiki({ langs: ['typescript', 'rust', 'go'] })
```

Every language is a grammar that has to be parsed and held in memory, so this is a list rather than _all of them_. The default covers bash, css, html, javascript, json, jsx, markdown, python, sh, tsx, typescript and yaml.

**A fence in a language you did not load renders as plain text.** It does not fail the build — ` ```mermaid ` in a corpus of a thousand documents is content, not a configuration error.

## Options

|                   |                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `theme`           | A [bundled theme](https://shiki.style/themes), or `{ light, dark }`                      |
| `langs`           | [Languages](https://shiki.style/languages) to load                                       |
| `transformers`    | Shiki transformers, e.g. from `@shikijs/transformers`                                    |
| `defaultLanguage` | Language for a fence that declares none. Default `'text'`, and it must be one you loaded |

## Fence metadata

Anything after the language reaches your transformers, so line highlighting and the rest work as they do elsewhere:

`````md
````ts {1,3}
```ts{1,3}
```ts twoslash
````
`````

```

All three forms are read — the brace-attached one because VitePress and others write it that way.

## Using @contentmap/unified?

Pass [`@shikijs/rehype`](https://shiki.style/packages/rehype) in `rehypePlugins` instead. It already has a home there, and this package would only be in the way.

## What it costs

|                     | packages | install size |
| ------------------- | -------- | ------------ |
| `contentmap` + zod  | 10       | 7.0 MB       |
| `@contentmap/shiki` | 46       | 25 MB        |

Where it goes, measured:

|                                 | size  | packages |
| ------------------------------- | ----- | -------- |
| `@shikijs/langs` — 722 grammars | 11 MB | 1        |
| `@shikijs/themes` — 132 themes  | 2 MB  | 1        |
| `shiki` core                    | 4 MB  | 1        |
| everything else                 | 6 MB  | 41       |

So the size is mostly data, but the _package count_ is mostly machinery: about twenty `hast`/`unist`/`micromark` utilities that build and serialise the HTML tree, and the `oniguruma-to-es` family, which translates the Oniguruma regex syntax TextMate grammars are written in into native `RegExp`.

It is not avoidable by configuring less. `@shikijs/langs` is a single package holding every grammar, so narrowing `langs` narrows what is _parsed and held in memory_, not what is installed.

**None of it reaches your users.** A page rendering contentmap output bundles 0.15 KB gzipped and contains no trace of Shiki — measured — because the colouring already happened. The usual alternative ships a highlighter to every visitor and runs it after paint.

That is also why it is a separate package: a project that does not highlight code installs none of this, and contentmap's own figures do not move.

## Links

- [contentmap documentation](https://github.com/satvikmaker/contentmap#readme)
- [Report an issue](https://github.com/satvikmaker/contentmap/issues)

MIT
```
