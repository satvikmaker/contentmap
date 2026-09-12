---
'contentmap': minor
---

`ctx.sourcePath` — the absolute path of the file a document was read from.

`meta.filePath` is relative to the collection's directory, so a transform wanting to `stat` its own source, read a sibling file, or ask git about it had to rebuild the path from the configured directory and assume the build was running in the project root. Migrating [svgl](https://github.com/pheralb/svgl), whose transform reads file timestamps for `createdAt` and `updatedAt`, that assumption was the only awkward part of the config.

Deliberately on the context rather than on `meta`: `meta` is serialized into every emitted document, and an absolute path there would write this machine's directory layout into generated output and make two checkouts disagree. It is `undefined` for a document that never came from a file — anything a `defineLoader` source or `http()` produced.
