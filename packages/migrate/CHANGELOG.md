# @contentmap/migrate

## 1.2.0

## 1.1.0

### Minor Changes

- ba01089: Completion callbacks migrate now, instead of being reported as unsupported. contentlayer's `onSuccess(importData)`, velite's `complete(data)` and content-collections' per-collection `onSuccess(docs)` become contentmap's `afterBuild`, kept exactly as written and handed the argument they expected, rebuilt from contentmap's documents — so the tag counts and search index a contentlayer starter writes keep being written. velite's `prepare`, which ran before output and could change it, is reported with where each part belongs.
- ee9b7ce: The codemod now handles configs the way real projects write them. Pointed at a popular contentlayer2 starter, it silently dropped five of six computed fields and produced a config that did not compile. Both are fixed, and every pattern it got wrong now has a fixture that is migrated and built for real in CI.

  - Spreads and shorthands are followed — `computedFields: { ...shared }`, `computedFields,`, `fields: { ...common }` — and anything that cannot be followed is named in the report instead of dropped.
  - The imports, constants and functions that moved code uses are carried into the new config, with relative imports re-pointed when it is written somewhere else.
  - Collections are named with the `inflection` package contentlayer used, so `Authors` stays `authors` rather than becoming `authorses`, and `Person` becomes `people`.
  - The body is rebuilt the way contentlayer shaped it — `body.raw` plus `body.code` or `body.html` — with MDX wired to `@contentmap/mdx` and markdown to `@contentmap/unified`, using the same remark and rehype plugins.
  - A resolver that cannot be inlined is called as written with a contentlayer-shaped document, so it runs unchanged instead of becoming a TODO. `_id` now maps to `ctx.meta.filePath`, which is what it held.
  - Every date field that turns from an ISO string into a `Date` is reported, with the one-line change that keeps the string, and so is contentlayer's skip-on-invalid default.
  - `json` fields become `z.any()`, matching contentlayer's `any`; nested types become `z.object()`.

### Patch Changes

- c42343f: A content-collections transform that names its context anything but `ctx` now migrates correctly. Moving `_meta` from the document onto the context always spelled the context `ctx`, so a transform written `(document, context) => …` — which is how [svgl](https://github.com/pheralb/svgl) writes it — produced a config referencing a parameter that does not exist. It looked right and failed at the first build with `ctx is not defined`.
- 649efeb: Three more ways a migrated config could come out broken, all found by pointing the codemod at configs this repository did not write.

  A content-collections transform only had `_meta` moved onto its context correctly when it was an arrow function with a named second parameter. Written `async function (doc, context)`, or taking a destructured context like `(doc, { documents })`, the emitted config referenced a `ctx` that was never declared — the same failure the previous release fixed for one shape out of four. Every shape is handled now: a named context keeps its name, a destructured one gains `meta` alongside what it already had, and a transform declared elsewhere that reads `_meta` is reported rather than carried over silently.

  A transform written as a method — `transform(doc) { … }`, which content-collections accepts and this codemod has always read — was emitted as `transform: transform(doc) { … }`, which is not JavaScript. It becomes a function expression now. The gate that checks generated configs parse did not catch that, because all three configs it checked happened to write their transform the same way; it checks the other shapes too now.

  A contentlayer `computedFields` entry called `type` collided with the type name now written onto each document, producing an object literal with the same key twice. The name is left to whichever half of the config claims it.

  A velite `output` key with no contentmap equivalent is reported instead of being passed over — the block itself stopped being dropped last release, but an unknown key inside it would still have gone quietly.

- 2e61c75: Two things a real migration turned up.

  Documents now carry contentlayer's `type` field — `type: 'Blog'` — unless the schema claims that name itself. Migrating tailwind-nextjs-starter-blog produced a search index identical to contentlayer's in every field but this one, which its pages and its index both read.

  The CLI now names the framework integration to install, the packages the migration replaces, and the old config to delete once the build passes. All three were missing, and the last one is not cosmetic: `next build` type-checks the whole project, and the leftover `contentlayer.config.ts` failed it.

- ea36c3e: A velite config's `output` block is now carried over instead of dropped.

  It was never read at all, which is the one way "nothing is dropped silently" breaks: `data` decides where documents are written, and `assets`, `base` and `name` decide where copied files land and what URL they get. Every key has an exact equivalent — `data` is `output.dir`, `base` is `assetsBase`, `name` is `assetsName`, and `assets` and `clean` keep their names — down to the `[hash:6]` token, so it is converted rather than reported. An `output` that cannot be followed statically now says so.

- b9ac348: A migrated velite config now sets `onValidationError: 'warn'`, which is what velite was already doing.

  velite prints a schema violation as `info`, keeps the document and exits 0; contentmap fails the build. Migrating [neobrutalism-components](https://github.com/ekmas/neobrutalism-components) that difference turned a green build red over one description three characters past its own `.max(100)` — worth knowing about, but not as a broken build on the first run. The note that comes with it says how to tighten it back up once the content is clean.

## 1.0.1

## 1.0.0

## 0.5.2

## 0.5.1

## 0.5.0

## 0.4.1

## 0.4.0

## 0.3.1

## 0.3.0

## 0.2.0

## 0.1.1
