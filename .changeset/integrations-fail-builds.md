---
'@contentmap/vite': minor
'@contentmap/next': minor
'@contentmap/nuxt': minor
'@contentmap/webpack': minor
'@contentmap/astro': minor
---

A production build through any integration now fails on exactly what makes `contentmap build` exit 1, with the same report. Until now `vite build`, `next build`, `nuxt build` and a production webpack compile ignored content errors entirely, and Astro only warned — so a document that failed its schema vanished from the site while the build reported success. In development each integration prints the report and keeps serving, as `contentmap dev` does.
