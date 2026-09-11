---
'contentmap': patch
---

`ctx.documents(posts)` finds a collection whose definition never set `name`. `name` has been optional since 0.2 — it defaults to the key in `collections` — but a definition passed back to `documents()`, `resolve()` or `resolveMany()` was looked up by its own `name`, and failed with "Unknown collection" for a collection that plainly existed.
