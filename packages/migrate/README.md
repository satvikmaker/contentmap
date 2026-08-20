# @contentmap/migrate

Turn a [contentlayer2](https://github.com/timlrx/contentlayer2), [velite](https://velite.js.org) or [content-collections](https://www.content-collections.dev) config into a [contentmap](https://github.com/satvikmaker/contentmap) one.

```sh
npx @contentmap/migrate
```

It finds your existing config, writes `contentmap.config.ts` beside it, and writes `CONTENTMAP-MIGRATION.md` listing anything that needs a human. **Your original config is never modified**, and an existing `contentmap.config.ts` is never overwritten without `--force`.

## What it does, honestly

A config is arbitrary TypeScript, so no tool can convert one completely. This one translates what is mechanical, rewrites what has an exact equivalent, and reports the rest rather than guessing.

**contentlayer2** is the furthest from contentmap and gets the most out of this. Its field DSL becomes a zod schema — `{ type: 'date', required: true }` becomes `z.coerce.date()`, `{ type: 'enum', options: [...] }` becomes `z.enum([...])`, `default` becomes `.default()`, and an absent `required` becomes `.optional()`. `computedFields` move into a `transform`, with the document shape rewritten onto contentmap's context:

| contentlayer              | contentmap           |
| ------------------------- | -------------------- |
| `doc._raw.flattenedPath`  | `ctx.meta.path`      |
| `doc._raw.sourceFileName` | `ctx.meta.fileName`  |
| `doc._raw.sourceFilePath` | `ctx.meta.filePath`  |
| `doc._raw.sourceFileDir`  | `ctx.meta.directory` |
| `doc.body.raw`            | `ctx.body`           |
| `doc._id`                 | `ctx.meta.id`        |

These are exact equivalents, which is what makes rewriting them automatically safe. A resolver that is not a single expression is carried over verbatim with a `TODO`, because reducing it would be guessing.

**velite**'s `s` is zod plus about a dozen helpers. Plain zod passes straight through, chained methods and all. `s.isodate()` becomes `z.coerce.date()`. The helpers that are build-time work rather than validation — `s.markdown()`, `s.image()`, `s.excerpt()`, `s.toc()`, `s.metadata()` — are reported with the transform that replaces each one, since contentmap does that work in `transform` rather than in the schema.

**content-collections** is closest: both tools validate with a Standard Schema and spell a collection the same way, so the schema is lifted rather than rebuilt. The array of collections becomes an object, and `doc._meta` moves to `ctx.meta` — contentmap validates first and passes only the schema's own output, so `_meta` lives on the context. If your transform did not take a context parameter, it gets one.

## What it will not do

- **Compile MDX.** contentmap does not, so a collection relying on it is flagged rather than half-converted
- **Convert build hooks.** `onSuccess`, `prepare`, `complete` and `hooks` have no equivalent; run that work around `contentmap build`
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

const result = migrate(source, 'contentlayer2')
result.config // the generated contentmap.config.ts
result.notes // what needs a human, each with a hint
```

## Links

- [contentmap documentation](https://github.com/satvikmaker/contentmap#readme)
- [Report an issue](https://github.com/satvikmaker/contentmap/issues)

MIT
