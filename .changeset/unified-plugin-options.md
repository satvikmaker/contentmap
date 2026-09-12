---
'@contentmap/unified': patch
---

`remarkPlugins` and `rehypePlugins` now accept a configured plugin, `[plugin, options]`.

That tuple is how every remark/rehype config in the ecosystem passes options, but it was handed to unified's `use()` whole — and `use()` reads a bare array as a _list_ of pluggables, so the options object was taken for a preset and rejected with `Expected usable value but received an empty preset`. Migrating [svgl](https://github.com/pheralb/svgl), which configures shiki that way, failed on every document. The option types were `readonly Plugin[]`, which could not express a configured plugin either; they are now `readonly UnifiedPlugin[]`, a type this package exports.
