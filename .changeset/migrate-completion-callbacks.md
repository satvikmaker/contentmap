---
'@contentmap/migrate': minor
---

Completion callbacks migrate now, instead of being reported as unsupported. contentlayer's `onSuccess(importData)`, velite's `complete(data)` and content-collections' per-collection `onSuccess(docs)` become contentmap's `afterBuild`, kept exactly as written and handed the argument they expected, rebuilt from contentmap's documents — so the tag counts and search index a contentlayer starter writes keep being written. velite's `prepare`, which ran before output and could change it, is reported with where each part belongs.
