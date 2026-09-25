---
'@contentmap/search': minor
'contentmap': minor
---

New package: `@contentmap/search` — Pagefind, Orama or MiniSearch built from your collections after every successful build.

`fields` and `store` are separate options, and the difference is the point. A field in `fields` is tokenised into an inverted index, so the body is searchable and never travels; a field in `store` is copied into the payload so a hit can render. Storing a heavy field — `content`, `html`, `body` — warns, because that is the corpus, and the cost of shipping it does not show up until someone loads the page.

Each engine is an optional peer, and each one gets the handling a hand-written hook usually misses. MiniSearch indexes are written as `{ options, index }`, because `loadJSON` must be handed the options the index was built with and drift between them fails quietly. Orama's projection is load-bearing, since it keeps whole documents and returns one per hit. Pagefind metadata is coerced to strings first — hand it a `Date` and the service throws `invalid type: integer 3, expected a string` and fails the build naming neither document nor field — and its bundle is written through `ctx.writeFile` rather than its own `writeFiles()`, so it keeps the byte-compare, the atomic write, and the watcher exemption that stops a dev build rebuilding on its own output.

`collectionNameOf` is now exported from `contentmap`. The `afterBuild` context takes a `CollectionRef`, so any package built on it has to resolve one to a name the way the builder does — including a definition that never set a `name` of its own.
