# @contentmap/migrate

Turn a [contentlayer2](https://github.com/timlrx/contentlayer2), [velite](https://velite.js.org) or [content-collections](https://www.content-collections.dev) config into a [contentmap](https://github.com/satvikmaker/contentmap) one.

```sh
npx @contentmap/migrate
```

It finds your existing config, writes `contentmap.config.ts` beside it, and writes `CONTENTMAP-MIGRATION.md` listing anything that needs a human. **Your original config is never modified**, and an existing `contentmap.config.ts` is never overwritten without `--force`.

## What it does, honestly

A config is arbitrary TypeScript, so no tool can convert one completely. This one translates what is mechanical, rewrites what has an exact equivalent, carries across the code your config depends on, and reports the rest rather than guessing. **Nothing is dropped silently**: whatever it cannot follow is named in the report.

It reads configs the way people write them — `computedFields: { ...shared }`, a `computedFields,` shorthand naming a const, fields spread from a common object — and brings along the imports, constants and helper functions the moved code uses. Relative imports are re-pointed if the new config lives somewhere else.

**contentlayer2** is the furthest from contentmap and gets the most out of this.

- Its field DSL becomes a zod schema. `{ type: 'date', required: true }` becomes `z.coerce.date()`, `enum` becomes `z.enum([...])`, nested types become `z.object({...})`, `default` becomes `.default()`, and an absent `required` becomes `.optional()`.
- Collections are named with the `inflection` package contentlayer itself used, so `allAuthors` becomes `authors` and `allPeople` becomes `people`.
- Documents keep the shape your pages read: `body.raw`, plus `body.code` for MDX or `body.html` for markdown. MDX is wired to `@contentmap/mdx` and markdown to `@contentmap/unified`, with the same remark and rehype plugins.
- MDX compiles with `compat: 'mdx-bundler'`, so `useMDXComponent(post.body.code)` — and anything else built on mdx-bundler's `getMDXComponent`, such as pliny's `MDXLayoutRenderer` — keeps rendering.
- `computedFields` move into a `transform`, with the document shape rewritten onto contentmap's context:

| contentlayer              | contentmap           |
| ------------------------- | -------------------- |
| `doc._raw.flattenedPath`  | `ctx.meta.path`      |
| `doc._raw.sourceFileName` | `ctx.meta.fileName`  |
| `doc._raw.sourceFilePath` | `ctx.meta.filePath`  |
| `doc._raw.sourceFileDir`  | `ctx.meta.directory` |
| `doc._id`                 | `ctx.meta.filePath`  |
| `doc.type`                | the type's name      |
| `doc.body`                | the rebuilt body     |

These are exact equivalents, which is what makes rewriting them automatically safe. A resolver that is not a single expression is called exactly as written, with an object in the shape contentlayer passed it, so it runs unchanged.

Two differences are reported rather than papered over. Date fields become real `Date`s where contentlayer returned ISO strings, and the report gives the one-line change that keeps the string. And contentmap fails the build on an invalid document where contentlayer skipped it with a warning; the report says how to keep the old behaviour.

**Completion callbacks** — contentlayer's `onSuccess(importData)`, velite's `complete(data)` and content-collections' per-collection `onSuccess(docs)` — become contentmap's [`afterBuild`](https://github.com/satvikmaker/contentmap#after-the-build), kept exactly as written and handed the argument they expected, rebuilt from contentmap's documents. A tag-count or search-index file written there keeps being written, by the CLI and every framework integration alike.

**velite**'s `s` is zod plus about a dozen helpers. Plain zod passes straight through, chained methods and all, and so do schema fragments declared elsewhere in the file. `s.isodate()` becomes `z.coerce.date()`. The helpers that are build-time work rather than validation — `s.markdown()`, `s.image()`, `s.excerpt()`, `s.toc()`, `s.metadata()` — are reported with the transform that replaces each one.

**content-collections** is closest: both tools validate with a Standard Schema and spell a collection the same way, so the schema is lifted rather than rebuilt, along with any shared schema or helper it names. The array of collections becomes an object, and `doc._meta` moves to `ctx.meta` — contentmap validates first and passes only the schema's own output, so `_meta` lives on the context. If your transform did not take a context parameter, it gets one.

## What it will not do

- **Convert velite's `prepare`.** It ran before output was written and could change it; contentmap has no hook at that point. The report says where each part belongs — changes to documents in `transform`, anything else in `afterBuild`
- **Bundle imports inside MDX files.** contentlayer used mdx-bundler; `@contentmap/mdx` compiles each file on its own, so pass components when rendering
- **Follow code into other files.** A spread of an object imported from another module is reported, not read
- **Touch your components.** Only the config is translated. Imports in your app still point at the old package

## Options

```
--root <path>      Project directory (default: cwd)
-o, --out <path>   Where to write (default: contentmap.config.ts)
--report <path>    Where to write the notes (default: CONTENTMAP-MIGRATION.md)
--force            Overwrite an existing config
--dry-run          Print the result, write nothing
```

`--dry-run` first is a good habit.

## Programmatic

```ts
import { migrate, migrateProject } from '@contentmap/migrate'

const result = migrate(source, 'contentlayer2', 'contentlayer.config.ts', {
  // Where the new config will live, so carried relative imports still resolve.
  outFile: 'contentmap.config.ts'
})
result.config // the generated contentmap.config.ts
result.notes // what needs a human, each with a hint
result.install // the packages to add
```

## Links

- [contentmap documentation](https://github.com/satvikmaker/contentmap#readme)
- [Report an issue](https://github.com/satvikmaker/contentmap/issues)

MIT
