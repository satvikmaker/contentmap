# contentmap

## 0.4.0

### Minor Changes

- Adds `@contentmap/mdx`, so MDX compiles rather than being a dead end.

  `ctx.mdx()` returns a JavaScript function body — the same string contentlayer's `body.code` and velite's `s.mdx()` produce — which `run()` from `@mdx-js/mdx` turns into a component with your own JSX runtime. JSX, component imports and value exports all survive.

  The compiler is a new extension point (`MdxCompiler`) rather than a `Renderer`, because MDX does not produce HTML. Core gains an interface and a memoised `ctx.mdx()`; the toolchain itself stays in its own package, where a project rendering plain markdown never installs it.

  `@contentmap/migrate` now points contentlayer and velite MDX collections at it instead of reporting them unsupported.

## 0.3.1

### Patch Changes

- Removes a dead documentation URL from an error message, narrows four exports that were never public, and makes the collision diagnostic name the file to rename. Adds a docs gate that checks the API names the README claims in prose, not only its code examples.

## 0.3.0

### Minor Changes

- Two documents can no longer be given the same output filename.

  Module names were produced by replacing every unsafe character with `__`, which is lossy: `a b` and `a+b` both became `a__b`, as did any pair of non-latin filenames, since the whole name collapses. Both documents then raced to write one path and the build died on a rename with an `ENOENT` naming a temp file — for filenames as ordinary as a space and a plus.

  A short digest of the id is now appended whenever sanitising changed anything other than a `/`, so nested documents keep their readable filenames and everything else is unique. An emit-time check reports the one residual case — a file literally named `a__b` beside a directory `a/` — instead of racing for the file.

  Temp files used during an atomic write also carry a counter, so two writes to the same path can no longer clobber each other's temp file.

## 0.2.0

### Minor Changes

- Stabilization release.

  - `defineConfig` now rejects options that do not exist. A bare generic constraint accepted any extra key, so a misspelled or wrong option compiled, was ignored, and failed later as something unrelated — which is how `renderers: [markdown()]` reached three READMEs when the option is `renderer`.
  - `name` is optional on a collection and defaults to its key in `collections`, matching what the resolver has always done.
  - Dynamic `import('./schema.ts')` in a config is now tracked as a dependency, so editing that file reloads the config in dev.
  - Fixed the renderer and image option names in the `@contentmap/markdown`, `@contentmap/unified` and `@contentmap/image` READMEs, and in the codemod's hint.

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
