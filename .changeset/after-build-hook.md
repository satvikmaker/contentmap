---
'contentmap': minor
---

`afterBuild` runs after every build that succeeds — the first, and each rebuild in watch mode — with every collection's documents in hand. It is the place for work that needs the whole corpus: a search index, a feed, tag counts.

```ts
export default defineConfig({
  collections: { posts },
  afterBuild: async ctx => {
    const index = ctx.documents(posts).map(({ title, _meta }) => ({ title, path: _meta.path }))
    await ctx.writeFile('public/search.json', JSON.stringify(index))
  }
})
```

It runs inside the build, so `contentmap build`, `contentmap dev` and every framework integration run it the same way. `ctx.documents(posts)` keeps the collection's type. `ctx.writeFile` skips unchanged bytes, writes atomically, refuses a path outside the project, and is never mistaken by the watcher for a change. A hook that throws fails the build like any other error; hooks are skipped after a failed build and by `contentmap check`.

`BuildFailedError` and `formatDiagnostics` are exported for integrations that need to fail a build, or report one, the way the CLI does.
