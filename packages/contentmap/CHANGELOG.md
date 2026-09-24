# contentmap

## 1.1.0

### Minor Changes

- 07dce53: `afterBuild` runs after every build that succeeds — the first, and each rebuild in watch mode — with every collection's documents in hand. It is the place for work that needs the whole corpus: a search index, a feed, tag counts.

  ```ts
  export default defineConfig({
    collections: { posts },
    afterBuild: async ctx => {
      const index = ctx.documents(posts).map(({ title, _meta }) => ({ title, path: _meta.path }))
      await ctx.writeFile('public/search.json', JSON.stringify(index))
    }
  })
  ```

  It runs inside the build, so `contentmap build`, `contentmap dev` and every framework integration run it the same way. `ctx.documents(posts)` keeps the collection's type. `ctx.writeFile` skips unchanged bytes, writes atomically, refuses a path outside the project, and is never mistaken by the watcher for a change. A hook that throws fails the build like any other error; hooks are skipped after a failed build and by `contentmap check`.

  `BuildFailedError` and `formatDiagnostics` are exported for integrations that need to fail a build, or report one, the way the CLI does.

- 3e5a180: `ctx.sourcePath` — the absolute path of the file a document was read from.

  `meta.filePath` is relative to the collection's directory, so a transform wanting to `stat` its own source, read a sibling file, or ask git about it had to rebuild the path from the configured directory and assume the build was running in the project root. Migrating [svgl](https://github.com/pheralb/svgl), whose transform reads file timestamps for `createdAt` and `updatedAt`, that assumption was the only awkward part of the config.

  Deliberately on the context rather than on `meta`: `meta` is serialized into every emitted document, and an absolute path there would write this machine's directory layout into generated output and make two checkouts disagree. It is `undefined` for a document that never came from a file — anything a `defineLoader` source or `http()` produced.

### Patch Changes

- 375b075: The generated directory now carries `{ "type": "module" }`. Every module in it is ESM, and without that marker Node parses one as CommonJS, fails, reparses it and warns `MODULE_TYPELESS_PACKAGE_JSON` — which anything importing the output from a project that is not itself `"type": "module"` sees on every build. Migrating a real blog surfaced it: its post-build feed script printed the warning twice per build.
- 07dce53: `ctx.documents(posts)` finds a collection whose definition never set `name`. `name` has been optional since 0.2 — it defaults to the key in `collections` — but a definition passed back to `documents()`, `resolve()` or `resolveMany()` was looked up by its own `name`, and failed with "Unknown collection" for a collection that plainly existed.
- abd668a: `ctx.addWatchFile('./relative/path')` resolves against the document's own directory. It resolved against the project root instead, so for any collection outside the root it watched a file that did not exist, and editing the real one never rebuilt the document.

## 1.0.1

### Patch Changes

- Rewrites the README. Code now comes before prose, the comparison numbers are framed as three concrete problems they solve rather than a wall of tables, and the FAQ is collapsible so the page can be scanned in one screen. Every figure was re-measured and every link and anchor checked.

## 1.0.0

### Major Changes

- 1.0. The API is frozen and contentmap follows semver from here.

  Every exported symbol of every package is recorded under `api/`, generated from the emitted declarations and checked in CI, so a signature change that nobody intended fails the build instead of reaching a release. `CONTRIBUTING.md` documents what each release kind may change and the deprecation policy for anything being removed.

  No behaviour changes in this release. The version number is the change: `0.x` says _no stability promise_, and that was a barrier to adoption rather than an accurate description of the codebase.

## 0.5.2

### Patch Changes

- Fixes two problems in `@contentmap/shiki`. A `defaultLanguage` that was not loaded crashed the build from inside Shiki against whichever document happened to have a bare fence; it is now rejected when the config loads, naming the fix. And fence metadata — `{1,3}`, `twoslash` — was discarded rather than passed to transformers, which made the `transformers` option far less useful than it looked. Metadata attached without a space, as VitePress writes it, is now read too.

## 0.5.1

### Patch Changes

- Corrects the cost breakdown in the `@contentmap/shiki` README. It claimed the install was "nearly all grammars and themes"; measuring shows data is 59% of the size but only 3 of 45 packages — the rest is the hast/unist HTML-tree machinery and the Oniguruma-to-RegExp translator.

## 0.5.0

### Minor Changes

- Adds `@contentmap/shiki`, syntax highlighting built on Shiki.

  Highlighting runs at build time using the same TextMate grammars and themes VS Code uses, so the browser receives coloured HTML and no highlighter. It is a marked extension, passed through the default renderer's existing `extensions` option, so neither package needs to know about the other.

  Supports a single theme or a light/dark pair — the pair emits CSS variables, so a page can switch without re-highlighting. A fence in a language that was not loaded renders as plain text rather than failing the build.

## 0.4.1

### Patch Changes

- Fixes the MDX compiler's `baseUrl` on Windows. It was built by hand-encoding the path, which turns a drive letter into `C%3A` and leaves relative imports inside an MDX document resolving against a base URL the platform does not recognise. Uses `node:url`'s `pathToFileURL` instead.

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
