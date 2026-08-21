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
- [x] `ctx.markdown()`, `plain()`, `excerpt()`, `toc()`, `readingTime()`
- [x] Images: build-time dimensions, thumbhash placeholders, `sharp` optional
- [x] Assets: content-hashed copying, URL rewriting in rendered HTML, path-escape containment
- [x] Cross-collection references with cycle detection, resolved on demand
- [x] `ctx.cache()`, `ctx.emitFile()`, `ctx.addWatchFile()`, `ctx.skip()`
- [x] Persistent transform cache keyed by content digest, relocatable with `--cache-dir`

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
- [x] CLI/plugin output parity diffed in CI

### Migration

- [x] `@contentmap/migrate` for contentlayer2, velite and content-collections
- [x] Contentlayer field DSL to Zod, `computedFields` to a transform, `_raw` rewritten onto the context
- [x] A report of everything needing a human, with the exact replacement for each

### Engineering

- [x] CI matrix: Linux, macOS, Windows on Node 22 and 24
- [x] Gates for silent data loss, bundle size, install footprint, runtime budget, and user-project typechecking
- [x] Head-to-head benchmark against all three incumbents

---

## Next

The near-term list. These are the things most likely to change someone's mind about adopting.

### Content

- [ ] **MDX compilation** — the single most requested capability contentmap does not have. Frontmatter in `.mdx` already works; compiling to components does not
- [ ] **`@contentmap/shiki`** — syntax highlighting as a first-class renderer plugin, with themes and per-block languages
- [ ] **Search index generation** — emit an index consumable by Pagefind, Orama or MiniSearch without shipping the corpus
- [ ] **`@contentmap/git`** — last-modified dates, authors and history from git rather than from frontmatter people forget to update
- [ ] **Draft and preview modes** — a first-class way to include drafts in dev and exclude them in production
- [ ] **RSS, sitemap and feed helpers** — derived from collections you already declared

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

## Toward 1.0

1.0 means the API stops moving. The bar:

- [ ] **API freeze** with snapshot tests, so an accidental signature change fails CI
- [ ] **Semver commitment** and a documented deprecation policy
- [ ] **Ten frameworks proven in CI**, not five
- [ ] **Documentation site** covering every option and every context method
- [ ] **A migration guide per incumbent**, beyond the codemod
- [ ] **Real-world validation** — production sites of meaningful size, with their numbers published
- [ ] **Trusted publishing** for every package, with provenance attestations on each release

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
