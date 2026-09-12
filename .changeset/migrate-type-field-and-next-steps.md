---
'@contentmap/migrate': patch
---

Two things a real migration turned up.

Documents now carry contentlayer's `type` field — `type: 'Blog'` — unless the schema claims that name itself. Migrating tailwind-nextjs-starter-blog produced a search index identical to contentlayer's in every field but this one, which its pages and its index both read.

The CLI now names the framework integration to install, the packages the migration replaces, and the old config to delete once the build passes. All three were missing, and the last one is not cosmetic: `next build` type-checks the whole project, and the leftover `contentlayer.config.ts` failed it.
