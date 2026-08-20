<div align="center">

# contentmap

**The type-safe content layer for every framework.**

Files in. Typed data out. Next.js, Nuxt, Astro, SvelteKit, SolidStart, Qwik, React Router, TanStack Start, Vite — or no framework at all.

</div>

> **Status: pre-1.0, not yet published.** The build pipeline, renderers, assets, references, remote sources, watch mode and five framework adapters are implemented and tested. See [Status](#status) for what is still missing.

```bash
npx contentmap init
```

## Quickstart

```ts
// contentmap.config.ts
import { defineConfig, defineCollection } from 'contentmap'
import { markdown } from '@contentmap/markdown'
import { z } from 'zod'

const authors = defineCollection({
  name: 'authors',
  directory: 'content/authors',
  include: '**/*.yaml',
  schema: z.object({ id: z.string(), name: z.string() })
})

const posts = defineCollection({
  name: 'posts',
  directory: 'content/posts',
  include: '**/*.md',
  schema: z.object({
    title: z.string().max(120),
    date: z.coerce.date(),
    cover: z.string(),
    author: z.string(),
    draft: z.boolean().default(false)
  }),
  transform: async (doc, ctx) => {
    if (doc.draft) ctx.skip('draft')
    return {
      ...doc,
      slug: ctx.meta.slug,
      cover: await ctx.image(doc.cover),        // dimensions + a placeholder
      author: await ctx.resolve(authors, doc.author),  // joined, checked at build time
      html: await ctx.markdown(),
      reading: await ctx.readingTime()
    }
  }
})

export default defineConfig({
  collections: { authors, posts },
  renderer: markdown()
})
```

```ts
import { posts } from 'contentmap/generated'

const cards = posts
  .where({ draft: false })
  .select('title', 'slug', 'cover')   // → Pick<Post, 'title' | 'slug' | 'cover'>[]
  .sortBy('date', 'desc')
  .limit(10)
  .all()

cards[0].cover.placeholder   // ✅ generated at build time, zero client JS
cards[0].author              // ✗ compile error — not selected

const full = await posts.load('hello-world')   // bundles ONE document
```

## Why

Three tools own this space. Each solved part of the problem and hit a wall:

- **Contentlayer** — last release June 2023. Under Next 16's default Turbopack it does not merely fail to hot-reload; it never executes at all. Its `embedDocument` on lists declares `Author[]` while the JSON holds `string[]`. 287 packages, 134 MB.
- **Velite** — the best asset pipeline in the space, and 74% of its source is a vendored fork of Zod 3. It emits schema-violating data and exits 0 by default.
- **Content Collections** — the best DX and the cleanest dependency posture, and under a modest file-descriptor limit it silently lost 2,758 of 3,000 documents and exited 0. No image support at all.

All three emit **one array literal per collection**. That single decision is why an ordinary 680-post blog produces a 27 MiB module ([content-collections#784](https://github.com/sdorra/content-collections/issues/784)), why Contentlayer produced a 489 MB file at 15k documents, and why a one-character edit costs seconds to rebuild.

## What is different

| | |
|---|---|
| **Correct by default** | A green build cannot have silently dropped data. CI builds 3,000 documents under `ulimit -n 64` and fails if the build exits 0 with a truncated corpus |
| **Per-document output** | Read one post, bundle one post. Free code-splitting, fine-grained HMR, Turbopack compatibility |
| **Typed projections** | `select('title','date')` narrows to `Pick<Post, …>`. The only file-based tool where the query is part of the type surface |
| **Validator-agnostic** | zod, valibot, arktype, effect — all four tested for identical behaviour. No validator in our dependency tree |
| **CLI-first** | `contentmap build` is the product. CI asserts the Vite plugin's output is byte-identical to the CLI's |
| **Local and remote** | Markdown, MDX, YAML, JSON, JSONC, TOML — plus HTTP endpoints through the same schema, cache and type pipeline |

## Measured against the alternatives

One corpus of 1,000 markdown documents, every tool configured for frontmatter parsing plus schema validation. Reproduce with `pnpm bench:compare`.

| | packages | install size | files emitted |
|---|---|---|---|
| **contentmap** | **10** | **7.0 MB** | 1,004 |
| velite | 131 | 54.6 MB | 3 |
| content-collections | 41 | 62.7 MB | 4 |
| contentlayer2 | 287 | 134.0 MB | 1,009 |

*(Includes zod, which contentmap and content-collections both need. contentmap alone is 9 packages / 2.6 MB.)*

Two honest notes on this table.

**Build times are not shown.** Every measurement available was taken on a machine under heavy external load, where the same commit varied by 8×. Timing claims need an idle machine, and publishing numbers we cannot stand behind is the practice this project exists to avoid — velite's benchmark claims "1000+ documents" while testing 550, and content-collections publishes none at all.

**The file counts are the tradeoff, not an accident.** Emitting 1,004 files costs more to write than emitting 3. It buys the last row of the previous table: a page rendering ten cards from a 5,000-post collection bundles the index, not the corpus. content-collections bundles 16.3 MB for that same read.

## Framework setup

| Framework | Package | Setup |
|---|---|---|
| Vite, SvelteKit, SolidStart, Qwik, React Router, TanStack Start, Analog | `@contentmap/vite` | add `contentmap()` to `plugins` |
| Next.js (Turbopack and webpack) | `@contentmap/next` | wrap with `withContentmap()` |
| Nuxt | `@contentmap/nuxt` | add to `modules` |
| Astro | `@contentmap/astro` | use `contentmapLoader()` as a collection loader |
| webpack / Rspack | `@contentmap/webpack` | add `new ContentmapWebpackPlugin()` |
| Angular CLI | — | no plugin array exists; run `contentmap build` from `prebuild` |

Every adapter is a convenience. `contentmap build` produces identical output, and CI proves it — which is what keeps the tool alive when a bundler drops plugin support, as Turbopack did to Contentlayer.

## CLI

```
contentmap build      Build once. Non-zero exit on error.
contentmap dev        Build and watch.
contentmap check      Validate only; emit nothing. For CI.
contentmap clean      Remove generated output.
contentmap init       Scaffold config, sample content and tsconfig path.
```

Notable flags: `--frozen` (refuse the network; fail on a cold remote cache), `--json` (machine-readable diagnostics), `--on-validation-error=<fail|warn|skip|ignore>`, `--cache-dir` (put the incremental cache on a CI cache volume).

`--verbose` shows where the time went:

```
  phase      cumulative
  config     111ms
  read       31ms
  emit       31ms
  parse      7ms
  validate   3ms
  transform  2ms
  wall clock 185ms — phases run concurrently and do not sum to it
```

Only pipeline stages are listed, never an enclosing span as well — a row that is secretly the sum of three others below it reads as a finding and is really an artefact. `--json` carries the same numbers for per-commit tracking.

`--clean` removes generated output but keeps the cache. The two are different things, and discarding a cache whose correctness is guaranteed by content digests only buys a slower build — or, with `--frozen`, a failing one.

## Errors

```
✖ contentmap — 2 errors, 0 warnings in 1,284 documents (1,282 ok)

  Validation (1)
  └─ content/posts/hello.md:3:1
     date         Invalid date: "yesterday"
                    2 | title: Hello
                  > 3 | date: yesterday
                      | ^

  Missing reference (1)
  └─ content/posts/intro.md
     author       "authors/ghost" not found in collection "authors"
                  Did you mean "authors/ghosh"?
```

Grouped by kind, then by file, with a corpus-level summary. Every diagnostic names a file, and field-level ones carry a position and an excerpt.

## Status

Implemented and tested: the build pipeline, diagnostics, pluggable renderers, transforms, assets and image placeholders, cross-collection references, a persistent transform cache, remote sources, watch mode, and five framework adapters. 243 tests.

Not done:

- **Example applications.** Only Vite is proven end to end against a real toolchain. The other adapters are written against documented hook contracts with their behaviour asserted, but no Next, Nuxt, Astro or webpack app is built in CI.
- **Published build timings.** The harness exists; a quiet machine does not.
- **Migration codemods** from velite, content-collections and contentlayer.
- **A documentation site.** This README is the documentation.
- **`@contentmap/git`** for content in another repository.

Until those land, this is not 1.0.

## License

MIT
