<div align="center">

# contentmap

**Your Markdown, as typed TypeScript modules.**

[![npm](https://img.shields.io/npm/v/contentmap?color=black&label=npm)](https://www.npmjs.com/package/contentmap)
[![CI](https://img.shields.io/github/actions/workflow/status/satvikmaker/contentmap/ci.yml?branch=main&label=CI)](https://github.com/satvikmaker/contentmap/actions)
[![install size](https://img.shields.io/badge/install-7.0%20MB-black)](#the-numbers)
[![license](https://img.shields.io/npm/l/contentmap?color=black)](LICENSE)

[Quick look](#quick-look) · [Why switch](#why-people-switch) · [Install](#install) · [Frameworks](#frameworks) · [Migrating](#coming-from-contentlayer-velite-or-content-collections) · [FAQ](#faq)

</div>

---

contentmap is a **type-safe content layer** for JavaScript and TypeScript. It reads Markdown, MDX, YAML, JSON, TOML and remote APIs, validates every document against a schema you write, and emits typed modules your app imports directly.

It replaces [Contentlayer](https://github.com/timlrx/contentlayer2) (unmaintained), [Velite](https://velite.js.org) and [Content Collections](https://www.content-collections.dev) — and `npx @contentmap/migrate` converts your config from any of them.

## Quick look

**You write a schema.** Anything implementing [Standard Schema](https://standardschema.dev) works — zod, valibot, arktype, effect.

```ts
// contentmap.config.ts
import { defineCollection, defineConfig } from 'contentmap'
import { z } from 'zod'

const posts = defineCollection({
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

**You get a typed query.** No codegen step to remember, no `any` anywhere.

```ts
import { posts } from 'contentmap/generated'

const recent = posts
  .select('title', 'slug') // narrows the type to exactly these fields
  .where(p => !p.draft)
  .sortBy('date', 'desc') // sort by a field you didn't select
  .limit(5)
  .all()

const full = await posts.load('hello-world') // loads ONE document's body
```

That last line is the whole design. Every document is its own module, so listing posts never loads their contents.

## Why people switch

### Your bundle stays small

Rendering **10 cards from a 5,000-document collection** — a 7.5 MB corpus:

|                     | JavaScript shipped                             |
| ------------------- | ---------------------------------------------- |
| **contentmap**      | **1.3 MB** · 146 KB gzip — 17.9% of the corpus |
| Content Collections | 16.7 MB — _the entire corpus_                  |

Tools that emit one big array can't avoid this: importing a single field imports everything. contentmap emits a module per document plus a lazy index, so reading titles never touches bodies.

The client runtime that makes it work is **684 bytes** minified and gzipped — no dependencies, no `eval`, no `Proxy`. It runs under a strict CSP and on React Native.

### Your build fails when it should

Under a low file-descriptor limit, Content Collections **silently lost 2,758 of 3,000 documents and exited 0**. contentmap reads the full corpus, and a truncated build is structurally impossible — it's gated in CI on every commit.

> A document that violates its schema **fails the build by default.** Velite emits schema-violating data and exits 0.

### Your install doesn't balloon

<a name="the-numbers"></a>1,000 Markdown documents, every tool configured for frontmatter plus schema validation. Reproduce with `pnpm bench:compare`.

|                     | Install    | Packages | Maintained              |
| ------------------- | ---------- | -------- | ----------------------- |
| **contentmap**      | **7.0 MB** | **10**   | ✅                      |
| Content Collections | 62.7 MB    | 41       | ✅                      |
| Velite              | 54.6 MB    | 131      | ⚠️ quiet since Aug 2025 |
| Contentlayer2       | 134.0 MB   | 287      | ❌ unmaintained         |

**19× smaller than Contentlayer, 9× smaller than Content Collections.** contentmap and its eight dependencies come to 2.7 MB; the tenth package is your validator.

### It keeps working when your bundler changes

`contentmap build` is the product. Plugins are convenience, and CI diffs their output against the CLI's to keep that true — which is what kept Contentlayer alive for exactly as long as webpack was the only option.

## Install

```sh
npm i contentmap zod
npx contentmap init
```

`init` detects your framework, writes a config and a sample document, registers the tsconfig path, and updates `.gitignore`.

```sh
npx contentmap build
```

## Features

|                         |                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Any validator**       | zod, valibot, arktype, effect — all four tested for parity                                                                                        |
| **Any source**          | Markdown, MDX, YAML, JSON, JSONC, TOML, raw text, HTTP APIs, or your own via `defineLoader` / `defineParser`                                      |
| **Typed projections**   | `select()` narrows the row type; `where`, `sortBy` and `groupBy` still reach the whole index                                                      |
| **MDX**                 | JSX in content, components imported in, values exported out — via [`@contentmap/mdx`](packages/mdx)                                               |
| **Syntax highlighting** | VS Code grammars and themes at build time, light/dark aware — via [`@contentmap/shiki`](packages/shiki)                                           |
| **Images**              | Dimensions read at build time so pages stop jumping, plus [thumbhash](https://evanw.github.io/thumbhash/) placeholders — 21 bytes, zero client JS |
| **Assets**              | Content-hashed copying, URL rewriting in rendered HTML, orphan cleanup                                                                            |
| **References**          | Cross-collection lookups with cycle detection, resolved on demand                                                                                 |
| **Remote content**      | Digest-keyed revalidation, `--frozen` for offline CI, credentials screened out of the cache                                                       |
| **Incremental**         | Transform cache keyed by content digest — never by mtime alone                                                                                    |
| **Watch mode**          | Debounced, coalesced, one build at a time; a broken config keeps the last good output                                                             |
| **Diagnostics**         | Grouped by kind, with code frames, did-you-mean hints, and `--json` for CI                                                                        |

### Transform context

Inside `transform`, `ctx` gives you: `meta`, `body`, `markdown()`, `mdx()`, `plain()`, `excerpt()`, `toc()`, `readingTime()`, `image()`, `asset()`, `emitFile()`, `documents()`, `siblings()`, `reference()`, `addWatchFile()`, `cache()` and `skip()`.

### CLI

```
contentmap build      Build once. Non-zero exit on error.
contentmap dev        Build and watch.
contentmap check      Validate only; emit nothing. For CI.
contentmap clean      Remove generated output, keeping the cache.
contentmap init       Scaffold config, sample content and tsconfig path.
```

Useful flags: `--frozen` (refuse the network), `--json` (machine-readable), `--verbose` (per-phase timings), `--cache-dir`, `--concurrency`, `--on-validation-error`.

## Frameworks

| Framework                                                                     | Package               | Proven by                                   |
| ----------------------------------------------------------------------------- | --------------------- | ------------------------------------------- |
| Vite · SvelteKit · SolidStart · Qwik · React Router · TanStack Start · Analog | `@contentmap/vite`    | a real `vite build`                         |
| Next.js — Turbopack **and** webpack                                           | `@contentmap/next`    | [`examples/next`](examples/next)            |
| Nuxt                                                                          | `@contentmap/nuxt`    | [`examples/nuxt`](examples/nuxt)            |
| Astro                                                                         | `@contentmap/astro`   | [`examples/astro`](examples/astro)          |
| webpack · Rspack                                                              | `@contentmap/webpack` | [`examples/webpack`](examples/webpack)      |
| Anything else                                                                 | —                     | run `contentmap build` in your build script |

`pnpm verify:examples` builds all four applications with their real toolchains on every commit. That gate isn't decoration — writing those examples turned up four bugs every hook-level test had passed straight over, including a Nuxt module that never ran.

## Coming from Contentlayer, Velite or Content Collections?

```sh
npx @contentmap/migrate
```

Reads your existing config, writes a contentmap one beside it, and writes a report of anything needing a human. **Your original config is never modified.**

Contentlayer's field DSL becomes a Zod schema, `computedFields` become a transform, and the document shape is rewritten onto contentmap's context — `_raw.flattenedPath` → `ctx.meta.path`, `body.raw` → `ctx.body`. Those are exact equivalents, which is what makes rewriting them automatically safe. [Details](packages/migrate).

## FAQ

<details>
<summary><strong>What is contentmap?</strong></summary>

A build-time content layer: it reads your content files, validates them against a schema you define, and emits typed TypeScript modules your app imports.
</details>

<details>
<summary><strong>Is it a replacement for Contentlayer?</strong></summary>

Yes. Contentlayer is unmaintained — it died when its sponsor withdrew, and a volunteer maintainer's offer was closed by a stale bot. contentmap installs 19× smaller, works on Turbopack, and `npx @contentmap/migrate` converts your config.
</details>

<details>
<summary><strong>Does it support MDX?</strong></summary>

Yes, via [`@contentmap/mdx`](packages/mdx). It compiles to the same function-body string Contentlayer and Velite produce, so your rendering code ports across unchanged.
</details>

<details>
<summary><strong>Do I have to use Zod?</strong></summary>

No. Any [Standard Schema](https://standardschema.dev) validator works — valibot, arktype and effect are all tested for parity.
</details>

<details>
<summary><strong>Does it work without a bundler plugin?</strong></summary>

Yes, and that's the point. `contentmap build` is the product; plugins are a convenience whose output CI diffs against the CLI's.
</details>

<details>
<summary><strong>How much JavaScript reaches my users?</strong></summary>

684 bytes, minified and gzipped. Zero dependencies, no `eval`, no `Proxy`.
</details>

<details>
<summary><strong>Does it work on Windows?</strong></summary>

Yes. CI runs Linux, macOS and Windows on Node 22 and 24.
</details>

## Stability

**1.0 — semver from here.** Every exported symbol of every package is recorded under [`api/`](api), and CI fails on a signature change that wasn't deliberate. Patches fix bugs; minors add options and packages without breaking existing code; anything being removed is deprecated first with its replacement named. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

Shipped, and what's next — the detail lives in [ROADMAP.md](ROADMAP.md).

- [x] Typed pipeline, per-document output, typed projections
- [x] Markdown, MDX, YAML, JSON, JSONC, TOML, raw, and custom parsers
- [x] Syntax highlighting, images, assets, cross-collection references
- [x] Remote sources, watch mode, incremental cache
- [x] Five framework adapters, each proven against its real toolchain
- [x] A codemod for all three incumbents
- [ ] Search index generation for Pagefind, Orama and MiniSearch
- [ ] `@contentmap/git` — dates and authors from history
- [ ] Documentation site

[Open an issue](https://github.com/satvikmaker/contentmap/issues) to move something up the list.

## License

MIT
