# contentmap

**contentmap is a type-safe content layer for JavaScript and TypeScript projects.** It turns Markdown, MDX frontmatter, YAML, JSON, TOML and remote APIs into validated, fully-typed modules your app imports directly — with a CLI that works whether or not your bundler has a plugin API.

It is a modern alternative to [Contentlayer](https://github.com/timlrx/contentlayer2), [Velite](https://velite.js.org) and [Content Collections](https://www.content-collections.dev), and there is a codemod to migrate from any of them.

```sh
npm i contentmap zod
npx contentmap init
```

---

## Why contentmap: the numbers

One corpus of **1,000 Markdown documents**, every tool configured for frontmatter parsing plus schema validation. Reproduce with `pnpm bench:compare`.

|                     | Install size | npm packages | Emits       | Maintained              |
| ------------------- | ------------ | ------------ | ----------- | ----------------------- |
| **contentmap**      | **7.0 MB**   | **10**       | 1,004 files | ✅                      |
| Content Collections | 62.7 MB      | 41           | 4 files     | ✅                      |
| Velite              | 54.6 MB      | 131          | 3 files     | ⚠️ quiet since Aug 2025 |
| Contentlayer2       | 134.0 MB     | 287          | 1,009 files | ❌ unmaintained         |

**contentmap installs 19× smaller than Contentlayer and 9× smaller than Content Collections.** contentmap and its eight dependencies come to 2.7 MB — the tenth package is your validator.

### What reaches your browser

Rendering **10 cards from a 5,000-document collection** (a 7.5 MB corpus):

|                     | JavaScript bundled                             |
| ------------------- | ---------------------------------------------- |
| **contentmap**      | **1.3 MB** (146 KB gzip) — 17.9% of the corpus |
| Content Collections | 16.7 MB — the entire corpus                    |

contentmap emits **one module per document** plus a lazy index. Reading titles never loads bodies. Tools that emit a single array cannot do this: importing one field imports everything. The client runtime that makes this work is **684 bytes minified and gzipped**, with no `eval`, no `Proxy`, and zero dependencies — so it runs under a strict CSP and on React Native.

### Correctness under pressure

Under a low file-descriptor limit (`ulimit -n 64`), Content Collections **silently lost 2,758 of 3,000 documents and exited 0**. contentmap reads the full corpus and a truncated build is impossible: it is gated in CI on every commit.

> **contentmap fails the build by default when a document violates its schema.** Velite emits schema-violating data and exits 0.

### Speed

10,000 documents on a **4-core shared CI runner** (published with the machine stated, because wall-clock numbers do not travel between machines):

| Cold build | Incremental rescan | Peak memory |
| ---------- | ------------------ | ----------- |
| 2.1 s      | 396 ms             | 393 MB      |

`--verbose` prints where the time went, per pipeline stage.

---

## Quickstart

```ts
// contentmap.config.ts
import { defineCollection, defineConfig } from 'contentmap'
import { z } from 'zod'

const posts = defineCollection({
  name: 'posts',
  directory: 'content/posts',
  include: '**/*.md',
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    draft: z.boolean().default(false),
    content: z.string()
  }),
  transform: async (doc, ctx) => ({
    ...doc,
    slug: ctx.meta.slug,
    html: await ctx.markdown(),
    readingTime: await ctx.readingTime()
  })
})

export default defineConfig({ collections: { posts } })
```

```ts
// anywhere in your app — fully typed, no codegen step to remember
import { posts } from 'contentmap/generated'

const recent = posts
  .select('title', 'slug') // narrows the type to exactly these fields
  .where(p => !p.draft)
  .sortBy('date', 'desc') // sort by a field you did not select
  .limit(5)
  .all()

const full = await posts.load('hello-world') // loads ONE document's body
```

---

## Features

|                       |                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Any validator**     | zod, valibot, arktype, effect — anything implementing [Standard Schema](https://standardschema.dev). All four are tested for parity                                |
| **Any source**        | Markdown/MDX frontmatter, YAML, JSON, JSONC, TOML, raw text, plus HTTP APIs and custom sources via `defineLoader` / `defineParser`                                 |
| **Typed projections** | `select()` narrows the row type; `where`, `sortBy` and `groupBy` still reach the whole index                                                                       |
| **Images**            | Dimensions read at build time so pages stop jumping, plus [thumbhash](https://evanw.github.io/thumbhash/) placeholders — a 21-byte payload, zero client JavaScript |
| **Assets**            | Content-hashed copying, URL rewriting in rendered HTML, orphan cleanup driven by a manifest                                                                        |
| **References**        | Cross-collection lookups with cycle detection, resolved on demand                                                                                                  |
| **Remote content**    | Digest-keyed revalidation, `--frozen` for offline CI, and credentials screened out of the cache                                                                    |
| **Incremental**       | Persistent transform cache keyed by content digest — never by mtime alone                                                                                          |
| **Watch mode**        | Debounced, coalesced, single in-flight build; a broken config keeps the last good output                                                                           |
| **Diagnostics**       | Grouped by kind with code frames, did-you-mean hints, and `--json` for CI                                                                                          |
| **Type safety**       | `isolatedDeclarations`, unserializable values rejected at compile time, `InferDoc` / `InferIndex` helpers                                                          |

### Transform context

Inside `transform`, `ctx` gives you: `meta`, `body`, `markdown()`, `plain()`, `excerpt()`, `toc()`, `readingTime()`, `image()`, `asset()`, `emitFile()`, `documents()`, `siblings()`, `reference()`, `addWatchFile()`, `cache()` and `skip()`.

### CLI

```
contentmap build      Build once. Non-zero exit on error.
contentmap dev        Build and watch.
contentmap check      Validate only; emit nothing. For CI.
contentmap clean      Remove generated output, keeping the cache.
contentmap init       Scaffold config, sample content and tsconfig path.
```

Flags: `--frozen`, `--json`, `--verbose`, `--cache-dir`, `--concurrency`, `--format`, `--on-validation-error`, `--debounce`.

---

## Frameworks

| Framework                                                               | Package               | Proven by                                   |
| ----------------------------------------------------------------------- | --------------------- | ------------------------------------------- |
| Vite, SvelteKit, SolidStart, Qwik, React Router, TanStack Start, Analog | `@contentmap/vite`    | a real `vite build`                         |
| Next.js — Turbopack **and** webpack                                     | `@contentmap/next`    | [`examples/next`](examples/next)            |
| Nuxt                                                                    | `@contentmap/nuxt`    | [`examples/nuxt`](examples/nuxt)            |
| Astro                                                                   | `@contentmap/astro`   | [`examples/astro`](examples/astro)          |
| webpack / Rspack                                                        | `@contentmap/webpack` | [`examples/webpack`](examples/webpack)      |
| Anything else                                                           | —                     | run `contentmap build` in your build script |

Every adapter is a convenience, never a requirement. `contentmap build` produces identical output and CI diffs the two to keep that true — which is what keeps the tool alive when a bundler drops plugin support, **as Turbopack did to Contentlayer**.

---

## Migrating

```sh
npx @contentmap/migrate
```

Reads your existing Contentlayer, Velite or Content Collections config, writes a contentmap one beside it, and writes a report of anything needing a human. Your original config is never modified. Contentlayer's field DSL becomes a Zod schema and `computedFields` become a transform, with `_raw.flattenedPath` rewritten to `ctx.meta.path` and `body.raw` to `ctx.body`. [Details](packages/migrate).

---

## FAQ

**What is contentmap?**
A build-time content layer: it reads content files, validates them against a schema you define, and emits typed TypeScript modules your app imports.

**Is contentmap a replacement for Contentlayer?**
Yes. Contentlayer is unmaintained — it died when its sponsor withdrew, and a volunteer maintainer offer was closed by a stale bot. contentmap installs 19× smaller, works on Turbopack, and `npx @contentmap/migrate` converts your config.

**Does contentmap support MDX?**
Frontmatter in `.mdx` files, yes. Compiling MDX to components, not yet — compile it in your app.

**Do I have to use Zod?**
No. Any Standard Schema validator works: valibot, arktype and effect are all tested.

**Does it work without a bundler plugin?**
Yes, and that is the point. `contentmap build` is the product; plugins are a convenience.

**How big is the client runtime?**
684 bytes minified and gzipped. Zero dependencies, no `eval`, no `Proxy`.

**Does it work on Windows?**
Yes — CI runs Linux, macOS and Windows on Node 22 and 24.

---

## Roadmap

Shipped in 0.1 — see [ROADMAP.md](ROADMAP.md) for the detail.

- [x] Typed pipeline: any Standard Schema validator, per-document output, typed projections
- [x] Markdown, MDX frontmatter, YAML, JSON, JSONC, TOML, raw, and custom parsers
- [x] Images, assets, cross-collection references, persistent transform cache
- [x] Remote sources with digest revalidation, offline `--frozen` builds
- [x] Watch mode, diagnostics with code frames, `--json` for CI
- [x] Five framework adapters, each proven against its real toolchain in CI
- [x] `@contentmap/migrate` for contentlayer2, velite and content-collections

Coming next:

- [ ] MDX compilation
- [ ] `@contentmap/shiki` syntax highlighting
- [ ] Search index generation for Pagefind, Orama and MiniSearch
- [ ] `@contentmap/git` — dates and authors from history
- [ ] `$schema` autocomplete for frontmatter in your editor
- [ ] Documentation site
- [ ] Bun and Deno in the CI matrix

[Open an issue](https://github.com/satvikmaker/contentmap/issues) to move something up the list.

## License

MIT
