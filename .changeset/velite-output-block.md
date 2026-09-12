---
'@contentmap/migrate': patch
---

A velite config's `output` block is now carried over instead of dropped.

It was never read at all, which is the one way "nothing is dropped silently" breaks: `data` decides where documents are written, and `assets`, `base` and `name` decide where copied files land and what URL they get. Every key has an exact equivalent — `data` is `output.dir`, `base` is `assetsBase`, `name` is `assetsName`, and `assets` and `clean` keep their names — down to the `[hash:6]` token, so it is converted rather than reported. An `output` that cannot be followed statically now says so.
