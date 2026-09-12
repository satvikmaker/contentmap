---
'@contentmap/migrate': patch
---

A content-collections transform that names its context anything but `ctx` now migrates correctly. Moving `_meta` from the document onto the context always spelled the context `ctx`, so a transform written `(document, context) => …` — which is how [svgl](https://github.com/pheralb/svgl) writes it — produced a config referencing a parameter that does not exist. It looked right and failed at the first build with `ctx is not defined`.
