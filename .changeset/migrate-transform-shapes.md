---
'@contentmap/migrate': patch
---

Three more ways a migrated config could come out broken, all found by pointing the codemod at configs this repository did not write.

A content-collections transform only had `_meta` moved onto its context correctly when it was an arrow function with a named second parameter. Written `async function (doc, context)`, or taking a destructured context like `(doc, { documents })`, the emitted config referenced a `ctx` that was never declared — the same failure the previous release fixed for one shape out of four. Every shape is handled now: a named context keeps its name, a destructured one gains `meta` alongside what it already had, and a transform declared elsewhere that reads `_meta` is reported rather than carried over silently.

A transform written as a method — `transform(doc) { … }`, which content-collections accepts and this codemod has always read — was emitted as `transform: transform(doc) { … }`, which is not JavaScript. It becomes a function expression now. The gate that checks generated configs parse did not catch that, because all three configs it checked happened to write their transform the same way; it checks the other shapes too now.

A contentlayer `computedFields` entry called `type` collided with the type name now written onto each document, producing an object literal with the same key twice. The name is left to whichever half of the config claims it.

A velite `output` key with no contentmap equivalent is reported instead of being passed over — the block itself stopped being dropped last release, but an unknown key inside it would still have gone quietly.
