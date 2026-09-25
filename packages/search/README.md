# @contentmap/search

Search index hooks for [contentmap](https://github.com/satvikmaker/contentmap) — Pagefind, Orama or MiniSearch, built from your collections after every successful build.

```sh
npm i @contentmap/search minisearch   # or pagefind, or @orama/orama
```

```ts
import { defineCollection, defineConfig } from 'contentmap'
import { miniSearch } from '@contentmap/search'
import { z } from 'zod'

const posts = defineCollection({
  directory: 'content/posts',
  include: '**/*.md',
  schema: z.object({ title: z.string(), content: z.string() })
})

export default defineConfig({
  collections: { posts },
  afterBuild: miniSearch({
    collections: [posts],
    fields: ['title', 'content'], // searchable
    store: ['title', '_meta.path'], // carried into a hit
    out: 'public/search.json'
  })
})
```

## Indexed is not stored

`fields` and `store` are separate on purpose, and the difference is the whole point.

A field in `fields` is tokenised into an inverted index: the engine keeps terms, not prose, so the body is searchable and never travels. A field in `store` is copied into the payload verbatim, because a hit has to render as something.

Put `content` in `fields` and a query for a word in the body finds it. Put `content` in `store` and you have shipped the corpus — which is the thing contentmap exists to avoid, so it says so:

```
minisearch: storing content puts the full text of every document in the index.
Move it to `fields` to make it searchable without shipping it.
```

A warning rather than a refusal. A small corpus that genuinely wants its prose in the payload is a real choice; not knowing you made it is not.

## Engines

|              | ships                               | good for                                              |
| ------------ | ----------------------------------- | ----------------------------------------------------- |
| `miniSearch` | one JSON file, loaded whole         | a few hundred documents                               |
| `orama`      | one JSON file, loaded whole         | the same, with typed fields and facets                |
| `pagefind`   | a chunked bundle, fetched per query | thousands, where loading the index at all is the cost |

Each engine is an **optional peer**: install the one you use and nothing else arrives.

### `miniSearch`

Writes `{ options, index }` rather than the bare index. `MiniSearch.loadJSON` has to be handed the same options the index was built with, and drift between the two fails quietly rather than loudly — shipping them together is the only arrangement where a client cannot get it wrong.

```ts
const { options, index } = await fetch('/search.json').then(r => r.json())
const search = MiniSearch.loadJSON(JSON.stringify(index), options)
search.search('estuary')
```

### `orama`

```ts
import { restore } from '@orama/plugin-data-persistence'
const db = await restore('json', await fetch('/search.json').then(r => r.text()))
```

Orama keeps whole documents and returns one with every hit, so what is inserted is what ships. The projection is doing real work here.

### `pagefind`

```ts
pagefind({
  collections: [docs],
  fields: ['title', 'content'],
  store: ['title'],
  filters: ['tags'],
  out: 'public/pagefind'
})
```

Two things this does that a hand-written hook usually does not.

Pagefind's metadata is strictly flat strings, and frontmatter is full of dates and numbers. Hand it a `Date` and the service throws `invalid type: integer 3, expected a string`, failing the build with a message that names neither the document nor the field. Values are coerced first, dates to ISO.

The bundle is taken with `getFiles()` and written through `ctx.writeFile`, not left to Pagefind's own `writeFiles()`. Writing it directly skips the byte-compare, the atomic write, and the watcher exemption — so a dev build would notice a directory full of new files and rebuild on its own output.

## Options

|               |                                                                  |
| ------------- | ---------------------------------------------------------------- |
| `collections` | Collections to index. Pass the definitions, not their names.     |
| `fields`      | Searchable fields. Dotted paths work: `_meta.path`.              |
| `store`       | Fields carried into a hit. Keep it small.                        |
| `out`         | A file for `miniSearch` and `orama`, a directory for `pagefind`. |
| `id`          | Identity of a document. Defaults to `<collection>/<_meta.id>`.   |
| `filter`      | Index only the documents it keeps — drafts, say.                 |

## Links

- [contentmap](https://github.com/satvikmaker/contentmap)
- [`afterBuild`](https://github.com/satvikmaker/contentmap#after-the-build)
