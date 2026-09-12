# contentmap roadmap

What is built, what is coming, and roughly in what order. Ticked items are live on npm today.

Dates are deliberately absent. Items move when they are ready, and the ordering below reflects what unlocks the most for the most people rather than what is easiest.

**Want something moved up?** [Open an issue](https://github.com/satvikmaker/contentmap/issues) — real use cases reorder this list faster than anything else.

---

## Shipped

### Core pipeline

- [x] Config discovery for `contentmap.config.{ts,mts,js,mjs}`, project root only — never walking into a parent monorepo's config
- [x] Native `import()` loading with a `jiti` fallback, cache-busted on content digest
- [x] Glob collection with a `stat` prefilter, sorted for reproducible builds
- [x] Bounded-concurrency reads — never an unbounded `Promise.all`, gated in CI under `ulimit -n 64`
- [x] Content-digest change detection, paired with size so a same-millisecond rewrite is still seen
- [x] Parsers for frontmatter (`.md`, `.mdx`, `.markdown`), YAML, JSON, JSONC, TOML and raw text
- [x] Custom parsers via `defineParser`, dispatched per file extension
- [x] Array-at-root yields N documents, with issue paths prefixed by index

### Validation and types

- [x] [Standard Schema](https://standardschema.dev) — zod, valibot, arktype and effect, all four tested for parity
- [x] Build fails by default on a schema violation
- [x] Severity policy: `fail | warn | skip | ignore`
- [x] Unknown-field reporting with did-you-mean hints
- [x] Unserializable values rejected at compile time
- [x] `InferDoc` / `InferIndex` / `InferSchema` helpers
- [x] `isolatedDeclarations` throughout

### Output and query

- [x] One module per document plus a lazy index — reading titles never loads bodies
- [x] `bundle` format for small collections
- [x] Structured encoder preserving `Date`, `Map`, `Set`, `BigInt`, `RegExp`, `URL`
- [x] Byte-compare before write, atomic write, orphan cleanup from a manifest
- [x] Typed projections: `select` narrows the row type
- [x] `where`, `sortBy`, `groupBy`, `limit`, `skip`, `first`, `count`, `ids` reaching the whole index
- [x] `load()` / `loadAll()` for full documents, the only methods that trigger a dynamic import
- [x] Client runtime under 1 KB minified and gzipped, zero dependencies, no `eval`, no `Proxy`

### Content features

- [x] Renderers as opt-in packages: `@contentmap/markdown` (marked) and `@contentmap/unified` (remark/rehype)
- [x] MDX via `@contentmap/mdx` — JSX, component imports and value exports, compiled to a function body
- [x] MDX in mdx-bundler compat mode, so pages rendering with `getMDXComponent` or `useMDXComponent` keep working after a migration
- [x] `mdx({ minify: true })` — velite minified its MDX and this did not, which measured 2.5× larger on a real 54-document site; esbuild is an optional peer, so only the projects that ask for it install one
- [x] Syntax highlighting via `@contentmap/shiki` — VS Code grammars, single or light/dark themes
- [x] `ctx.markdown()`, `plain()`, `excerpt()`, `toc()`, `readingTime()`
- [x] Images: build-time dimensions, thumbhash placeholders, `sharp` optional
- [x] Assets: content-hashed copying, URL rewriting in rendered HTML, path-escape containment
- [x] Cross-collection references with cycle detection, resolved on demand
- [x] `ctx.cache()`, `ctx.emitFile()`, `ctx.addWatchFile()`, `ctx.skip()`
- [x] Persistent transform cache keyed by content digest, relocatable with `--cache-dir`
- [x] `afterBuild` — a hook with every document in hand, for search indexes, feeds and tag counts; run identically by the CLI and every integration, skipped after a failed build, and never mistaken by the watcher for a change

### Sources

- [x] Remote content via `http()` with digest-keyed revalidation
- [x] `--frozen` for offline and reproducible CI builds
- [x] Credentials screened out of the cache, and redacted in diagnostics
- [x] Custom sources via `defineLoader`

### Developer experience

- [x] `build`, `dev`, `check`, `clean`, `init`
- [x] Diagnostics grouped by kind with code frames and hints
- [x] `--json` for machine-readable CI output
- [x] `--verbose` per-phase timings
- [x] Watch mode: debounced, coalesced, single in-flight build; a broken config keeps the last good output
- [x] `contentmap init` — framework detection, config, sample content, tsconfig path, `.gitignore`

### Integrations

- [x] `@contentmap/vite` — Vite, SvelteKit, SolidStart, Qwik, React Router, TanStack Start, Analog
- [x] `@contentmap/next` — Turbopack **and** webpack
- [x] `@contentmap/nuxt`, `@contentmap/astro`, `@contentmap/webpack`
- [x] Every adapter proven against its real toolchain by an example application in CI
- [x] CLI/plugin output parity diffed in CI, `afterBuild` output included
- [x] Every adapter fails a production build on exactly what fails `contentmap build`, and reports it in dev

### Migration

- [x] `@contentmap/migrate` for contentlayer2, velite and content-collections
- [x] Contentlayer field DSL to Zod — nested types included — `computedFields` to a transform, `_raw` rewritten onto the context
- [x] Configs read the way people write them: spreads, shorthands and shared definitions followed
- [x] Imports, constants and helper functions the moved code uses, carried across
- [x] Contentlayer's document shape kept — `body.raw`, `body.code`, `body.html` — so pages keep rendering
- [x] Completion callbacks — contentlayer's and content-collections' `onSuccess`, velite's `complete` — become `afterBuild`
- [x] A report of everything needing a human, with the exact replacement for each; nothing dropped silently
- [x] Every pattern it handles has a fixture, migrated and built for real in CI

### Engineering

- [x] CI matrix: Linux, macOS, Windows on Node 22 and 24
- [x] Gates for silent data loss, bundle size, install footprint, runtime budget, and user-project typechecking
- [x] Head-to-head benchmark against all three incumbents

---

## Next

The near-term list. These are the things most likely to change someone's mind about adopting.

### Content

- [ ] **Search index helpers** — first-party `afterBuild` hooks emitting an index for Pagefind, Orama or MiniSearch without shipping the corpus. Writing one by hand is already a few lines
- [ ] **`@contentmap/git`** — last-modified dates, authors and history from git rather than from frontmatter people forget to update
- [ ] **Draft and preview modes** — a first-class way to include drafts in dev and exclude them in production
- [ ] **RSS, sitemap and feed helpers** — `afterBuild` hooks derived from collections you already declared

### Types and editors

- [ ] **`$schema` autocomplete** — emit JSON Schema so editors complete and validate frontmatter as you type it
- [ ] **Explicit `.d.ts` emission** — structural declarations rather than the trampoline, for projects that cannot resolve the config type
- [ ] **Better transform inference** — narrow `ctx.documents()` to the referenced collection's type

### Performance

- [ ] **Per-commit performance tracking** — a published history, so a regression is visible the day it lands rather than at the next release
- [ ] **Published build timings on idle hardware** — deliberately absent today, because numbers taken under load are worse than none
- [ ] **Static query extraction** — scan app source, emit exactly the projected shape, skip the index entirely
- [ ] **Optional query index** — only if published before-and-after numbers justify it

### Ecosystem

- [ ] **Documentation site** — searchable, versioned, with runnable examples
- [ ] **More framework examples in CI** — Angular, Remix, Eleventy, Docusaurus
- [ ] **Bun and Deno** — verified in the CI matrix rather than assumed
- [ ] **Monorepo support** — multiple configs, shared collections, project references

---

## 1.0

Reached. The API is frozen and contentmap follows semver from here.

- [x] **API freeze** — every exported symbol of every package is recorded under [`api/`](api), and CI fails on an unintended signature change
- [x] **Semver commitment** and a deprecation policy — see [CONTRIBUTING.md](CONTRIBUTING.md)
- [x] **Five frameworks proven in CI**, each by a real build of a real application
- [x] **A codemod per incumbent**, which is more use than a prose migration guide
- [ ] **Documentation site** — still the README
- [ ] **Real-world validation** — production sites, with their numbers published

### The gate was revised, not met

The original bar asked for ten frameworks in CI, a documentation site, and a written migration guide for each incumbent before 1.0. Two of those were cut, and it is worth saying why rather than quietly moving the line.

**Ten frameworks was a number, not a threshold.** Five are proven by real builds of real applications — Vite, Next on both bundlers, Nuxt, Astro and webpack — which is more end-to-end verification than any of the three incumbents ever had. The sixth through tenth would have been more of the same evidence, not different evidence.

**A migration guide per incumbent was superseded by the codemod**, which converts the config, rewrites what has an exact equivalent, and reports what does not with the replacement named. Prose would restate it less precisely.

**The documentation site was not cut**, and neither was real-world validation. Both remain open. Neither is a stability question, and holding the version at 0.x until they land was itself the problem: `0.x` says _no stability promise_, and nobody builds a content pipeline on that. The API is what needed freezing, and it is frozen.

### Real-world validation

Applications nobody here wrote, migrated and built. The item stays open until there are several more.

#### contentlayer2 → contentmap: tailwind-nextjs-starter-blog

[tailwind-nextjs-starter-blog](https://github.com/timlrx/tailwind-nextjs-starter-blog) at [`b45bef6`](https://github.com/timlrx/tailwind-nextjs-starter-blog/commit/b45bef66b40c63b6f57c15ee8cd090682238df4c) — 13 documents, MDX, a search index, an RSS feed, tag counts, nobody here wrote a line of it. Migrated with `@contentmap/migrate`, then built with `next build`. Reproduce all of it with [`scripts/real-world.mjs`](scripts/real-world.mjs), which clones that pin, migrates it, applies the application patch beside it and measures both sides.

|                                           | contentlayer2            | contentmap              |
| ----------------------------------------- | ------------------------ | ----------------------- |
| Install, added to a Next + React baseline | +394 packages, +119.4 MB | +148 packages, +13.7 MB |
| Generated data                            | 1.66 MB                  | 0.91 MB                 |
| Application code changed                  | —                        | 20 files, +88 −44       |
| Routes built                              | 21                       | 21                      |
| Shared First Load JS                      | 102 kB                   | 102 kB                  |

Most of that application diff is one new 38-line `lib/content.ts`, standing in for the `allBlogs` and `allAuthors` exports contentlayer generated. The other nineteen files change an import line or two each; no page's logic was rewritten.

It is the same site afterwards, which is the part worth checking hardest: `public/feed.xml` is byte-identical, `app/tag-data.json` is identical as data, and `public/search.json` is identical on every field both tools emit.

Three things those numbers do not say, because a measurement without its conditions is advertising:

- **The project's whole `node_modules` grew**, 573.4 MB to 582.4 MB. The starter depends on `pliny`, which depends on contentlayer2, so the old tool stays installed regardless. The install row measures each content layer against a 306-package, 314.7 MB baseline that already holds next, react and react-dom — the part a project actually chooses. It has to be a difference rather than a raw closure, because `next-contentlayer2` declares `next` as a dependency where `@contentmap/next` takes it as a peer: measured raw, contentlayer is charged 434 MB for carrying Next around inside its own closure, which flatters contentmap by about 300 MB and is not a real cost.
- **There is no build-time row**, and the reason is worth more than the number would have been. `real-world.mjs` times the two sides in alternating pairs and discards any pair whose load average moved between its halves; on the run that produced this table all three pairs were discarded, so it reported nothing. What the discarded pairs show is why: builds came in at 23.6s and 95.4s on contentlayer, and at 22.7s, 91.6s and 17.4s on contentmap. The spikes land on both sides because they are not the content layer — `app/layout.tsx` pulls Space Grotesk through `next/font/google`, a cold build deletes `.next` and its font cache with it, and every build therefore refetches from Google. A number goes in this row when there is idle hardware and a warm font cache to produce it honestly.
- **The migration was not automatic.** The codemod converted the config and reported the rest: this starter sorts and formats dates as strings, so its `z.coerce.date()` fields needed a `.transform()` back to ISO, and the old `contentlayer.config.ts` had to be deleted before `next build` would pass, because it type-checks files nothing imports. Both are in the report it prints. Three fixes here came out of the attempt — documents now carry contentlayer's `type` field, the generated directory is marked ESM, and the CLI now names the integration to install, the packages to remove, and the config to delete.

#### content-collections → contentmap: svgl

[svgl](https://github.com/pheralb/svgl) at [`b496499`](https://github.com/pheralb/svgl/commit/b49649915224db817b89ff400b940a2a93bdb3d3) — a SvelteKit site whose docs run through shiki, autolinked headings, external-link rewriting and two rehype plugins of its own. A different incumbent and a different integration from the entry above: this one goes through `@contentmap/vite`, and its markdown goes through `@contentmap/unified` because of those plugins.

|                                            | content-collections     | contentmap              |
| ------------------------------------------ | ----------------------- | ----------------------- |
| Install, added to a Svelte + Vite baseline | +122 packages, +56.4 MB | +116 packages, +11.9 MB |
| Generated data                             | 196 kB                  | 116 kB                  |
| Application code changed                   | —                       | 6 files, +19 −14        |
| Whole `node_modules`                       | 341.6 MB                | 333.5 MB                |

Every field the two tools derive from content came out identical — `html` (shiki highlighting included), `content`, `tableOfContents`, `title`, `description` and both URL fields. The only two that differ, `createdAt` and `updatedAt`, are read with `fs.stat` from the source file, and the two checkouts were written to disk four seconds apart.

Two things worth saying plainly:

- **The package count barely moves**, because `@contentmap/unified` brings the remark/rehype tree with it — that renderer is the heavy option and its own documentation says so. The size is what changes, 56.4 MB to 11.9 MB. A project that does not need rehype plugins uses `@contentmap/markdown` and pays far less than either.
- **Two bugs came out of this one, both found by building rather than by reading.** The codemod spelled the transform's context `ctx` no matter what the config called it, so svgl's `(document, context) => …` produced a config referencing a parameter that did not exist. And `@contentmap/unified` could not accept `[plugin, options]` — the way the entire remark/rehype ecosystem configures a plugin — so every document failed on the first real config that used it.

#### velite → contentmap: neobrutalism-components

[neobrutalism-components](https://github.com/ekmas/neobrutalism-components) at [`532ebeb`](https://github.com/ekmas/neobrutalism-components/commit/532ebeb) — 54 MDX documents on Next, compiled through `remark-code-import`, `rehype-pretty-code` with a theme read off disk, an extracted table of contents and two tree visitors the project wrote itself.

|                                           | velite                  | contentmap              |
| ----------------------------------------- | ----------------------- | ----------------------- |
| Install, added to a Next + React baseline | +150 packages, +40.3 MB | +148 packages, +13.7 MB |
| Generated data                            | 3.04 MB                 | 3.30 MB                 |
| Application code changed                  | —                       | 3 files, +12 −15        |
| Static pages                              | 65 of 65                | 65 of 65                |
| Shared First Load JS                      | 102 kB                  | 102 kB                  |

All 53 prerendered documentation pages come out identical, `rehype-pretty-code`'s syntax highlighting included — the only bytes that differ between the two builds are Next's own per-build ids and chunk hashes.

Three things worth saying plainly:

- **The generated-data row is the reason `@contentmap/mdx` now minifies.** Measured the first time, contentmap wrote 7.69 MB against velite's 3.04 MB — 2.5× more, because velite runs its compiled MDX through esbuild and this did not. One page's body was 20,693 characters out of velite and 52,316 out of contentmap. `mdx({ minify: true })` closes it to the 3.30 MB above, with all 53 pages still rendering identically; esbuild is an optional peer, so nobody who leaves the option alone pays for it.
- **The build went red on content velite had been shipping.** velite reports a schema violation as `info`, keeps the document and exits 0; contentmap fails. 53 of 54 documents built and the whole thing stopped on one description three characters past the `.max(100)` the project's own schema asks for. A migrated config now carries `onValidationError: 'warn'` so the first build after a migration behaves the way the last build before it did, with a note saying how to tighten it once the content is clean.
- **The `output` block used to vanish.** velite's `data`, `assets`, `base` and `name` were never read by the codemod, which is the one way "nothing is dropped silently" actually broke. They map field for field and are carried now.

---

## Exploring

Ideas with a real case behind them, not yet committed to. Weigh in on any of these in an issue.

- [ ] **First-party CMS loaders** — Contentful, Sanity, Storyblok, Payload on top of the `http()` primitive
- [ ] **i18n** — locale-aware collections with fallback chains. No tool in this space supports it properly
- [ ] **Live collections** — request-time loaders with in-band errors, for content that cannot be built ahead
- [ ] **Page trees and navigation** — build emits files, a pure runtime assembles the tree
- [ ] **CMS field derivation** — generate a CMS schema from the one you already wrote
- [ ] **Image transforms** — AVIF and WebP conversion, responsive `srcset` generation
- [ ] **Content relations linting** — catch a broken cross-reference before it reaches a page
- [ ] **Plugin API** — a documented surface for third-party renderers, loaders and parsers
- [ ] **LSP integration** — go-to-definition from a reference to the document it names

---

## Principles

The constraints that decide what gets built, and what gets refused.

|                                  |                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The CLI is the product**       | Bundler plugins are a convenience and are diffed against the CLI in CI. Contentlayer stopped executing the day Turbopack arrived; that must never be possible here |
| **Small on purpose**             | Every dependency is argued for. No forks of other people's libraries, no FP framework, plain TypeScript that any TypeScript developer can maintain                 |
| **Silence is the enemy**         | A build that cannot read its content must never report success. Gated in CI, not merely intended                                                                   |
| **Measured, not asserted**       | Every number in the README is reproducible from a script in this repository. Benchmarks state their hardware                                                       |
| **Maintainable by someone else** | Documented internals, tests as executable specification, no exotic abstractions. Bus factor is what killed the last one                                            |
