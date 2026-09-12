---
'@contentmap/migrate': patch
---

A migrated velite config now sets `onValidationError: 'warn'`, which is what velite was already doing.

velite prints a schema violation as `info`, keeps the document and exits 0; contentmap fails the build. Migrating [neobrutalism-components](https://github.com/ekmas/neobrutalism-components) that difference turned a green build red over one description three characters past its own `.max(100)` — worth knowing about, but not as a broken build on the first run. The note that comes with it says how to tighten it back up once the content is clean.
