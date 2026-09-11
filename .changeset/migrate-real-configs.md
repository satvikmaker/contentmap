---
'@contentmap/migrate': minor
---

The codemod now handles configs the way real projects write them. Pointed at a popular contentlayer2 starter, it silently dropped five of six computed fields and produced a config that did not compile. Both are fixed, and every pattern it got wrong now has a fixture that is migrated and built for real in CI.

- Spreads and shorthands are followed — `computedFields: { ...shared }`, `computedFields,`, `fields: { ...common }` — and anything that cannot be followed is named in the report instead of dropped.
- The imports, constants and functions that moved code uses are carried into the new config, with relative imports re-pointed when it is written somewhere else.
- Collections are named with the `inflection` package contentlayer used, so `Authors` stays `authors` rather than becoming `authorses`, and `Person` becomes `people`.
- The body is rebuilt the way contentlayer shaped it — `body.raw` plus `body.code` or `body.html` — with MDX wired to `@contentmap/mdx` and markdown to `@contentmap/unified`, using the same remark and rehype plugins.
- A resolver that cannot be inlined is called as written with a contentlayer-shaped document, so it runs unchanged instead of becoming a TODO. `_id` now maps to `ctx.meta.filePath`, which is what it held.
- Every date field that turns from an ISO string into a `Date` is reported, with the one-line change that keeps the string, and so is contentlayer's skip-on-invalid default.
- `json` fields become `z.any()`, matching contentlayer's `any`; nested types become `z.object()`.
