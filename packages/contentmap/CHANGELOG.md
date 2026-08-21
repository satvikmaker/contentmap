# contentmap

## 0.1.1

### Patch Changes

- Fix `@contentmap/migrate`'s CLI producing no output when invoked through its bin. The entrypoint was guarded on `import.meta.url === file://${process.argv[1]}`, and npm links a bin as a symlink, so the two never match — `npx @contentmap/migrate` did nothing at all.

## 0.1.0

### Minor Changes

- feb9236: First published release.

  A content layer that turns Markdown, JSON, YAML, TOML and remote sources into typed, per-document modules, with a CLI that works whether or not your bundler has a plugin API.

  - **Standard Schema validation** — zod, valibot, arktype and effect all work, and all four are tested for parity. A schema violation fails the build by default rather than being emitted and exiting 0
  - **Per-document emission** — reading an index does not pull the corpus into your bundle. Measured through a real webpack build: titles in the main chunk, bodies in lazy ones
  - **Typed projections** — `select` narrows the row type; `sortBy`, `where` and `groupBy` still reach the whole index, so you can render two fields and order by a third
  - **Assets and images** — dimensions at build time so pages stop jumping, plus thumbhash placeholders that need no client JavaScript
  - **Cross-collection references**, a persistent transform cache, remote sources with digest-keyed revalidation, and watch mode
  - **A migration codemod** — `npx @contentmap/migrate` converts a contentlayer2, velite or content-collections config and reports what needs a human
  - **Five framework adapters** — Vite (covering SvelteKit, SolidStart, Qwik, React Router, TanStack Start and Analog), Next on both Turbopack and webpack, Nuxt, Astro, and webpack/Rspack. Each is proven against its real toolchain by an example application in CI

  Nine packages, ten runtime dependencies, 7.0 MB installed. Every adapter is a convenience: `contentmap build` produces identical output, and CI diffs the two to keep that true.

  This is a 0.x release and carries no stability promise yet. The API is exercised by 257 tests and a CI matrix across Linux, macOS and Windows on Node 22 and 24, but it has not been through contact with real projects.
