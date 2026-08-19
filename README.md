<div align="center">

# contentmap

**The type-safe content layer for every framework.**

Files in. Typed data out. Next.js, Nuxt, Astro, SvelteKit, SolidStart, Qwik, React Router, TanStack Start, Vite — or no framework at all.

</div>

> **Status: design phase.** No code yet. The specification is complete and grounded in a full source-level audit of the tools this replaces. See [PRD](docs/PRD.md) · [Spec](docs/SPEC.md) · [Architecture](docs/ARCHITECTURE.md) · [Roadmap](docs/ROADMAP.md).

---

```ts
// contentmap.config.ts
import { defineConfig, defineCollection } from 'contentmap'
import { z } from 'zod'

const posts = defineCollection({
  name: 'posts',
  directory: 'content/posts',
  include: '**/*.md',
  schema: z.object({
    title: z.string().max(120),
    date: z.coerce.date(),
    cover: z.string(),
    author: z.string()
  }),
  transform: async (doc, ctx) => ({
    ...doc,
    slug: ctx.meta.path,
    cover: await ctx.image(doc.cover),        // → { src, width, height, blurDataURL }
    author: await ctx.resolve(authors, doc.author),  // joined, checked at build time
    html: await ctx.markdown(),
    reading: ctx.readingTime()
  })
})

export default defineConfig({ collections: { authors, posts } })
```

```ts
import { posts, getPost } from 'contentmap/generated'

posts[0].author.name         // string  — joined at build time
posts[0].cover.blurDataURL   // string  — generated, zero client JS
const one = await getPost('hello-world')   // bundles ONE document, not the corpus
```

## Why

Three tools own this space, and each hit a wall. We read all of their source and reproduced the failures:

- **Contentlayer** is dead — last release June 2023. Under Next 16's default Turbopack it doesn't just fail to hot-reload; **it never executes at all**. Its `embedDocument` on lists generates `Author[]` in the `.d.ts` while the JSON holds `string[]`. 185 MB install, 64% of it an unused tracing stack.
- **Velite** has the best asset pipeline in the space — and **74% of its source is a vendored fork of Zod 3**. It emits schema-violating data and exits 0 by default; a real violation logs at `info` while its own advisory note logs at `warning`.
- **Content Collections** has the best DX and the cleanest dependency posture — and under a modest file-descriptor limit it **silently lost 2,758 of 3,000 documents and exited 0**, because errors are emitted before a consumer can subscribe. It has no image support at all.

And all three emit one array literal per collection. That single decision is why Contentlayer produced a **489 MB** generated file at 15k documents, why reading one title from a 5,000-post Content Collections build bundles **17.1 MB**, and why a one-character edit costs a 2-second rebuild.

## What's different

| | |
|---|---|
| **Correct by default** | A green build cannot have silently dropped data. Enforced by a CI test that builds under `ulimit -n 64` and asserts non-zero exit |
| **Per-document modules** | Read one post, bundle one post. Free code-splitting, fine-grained HMR, and Turbopack compatibility |
| **CLI-first** | `contentmap build` is the product. Every bundler plugin is a convenience wrapper — CI proves output is identical without it |
| **Validator-agnostic** | Zod, Valibot, ArkType, Effect Schema. Zero validators in our dependency tree |
| **JSON Schema IR** | Built on `StandardJSONSchemaV1`, which nobody else uses yet. One artifact → types, editor `$schema` autocomplete, CMS fields |
| **Honestly lightweight** | Target: **7 packages / 2.34 MB**. Velite is 129 / 41.9 MB; `@content-collections/core` is 27 / 43.7 MB. We publish the real `npm i` number |
| **Errors that help** | Contentlayer's corpus-level aggregation — the one thing the ecosystem regressed on — on Standard Schema issues |

## Research

Six engineering reports, all from reading source and running measurements — not documentation:

| | |
|---|---|
| [velite.md](docs/research/velite.md) | Four reproduced bugs; the Zod fork; the `.d.ts` trick worth stealing |
| [content-collections.md](docs/research/content-collections.md) | The 92% silent data loss; the type trampoline; the 17.8 MB ceiling |
| [contentlayer2.md](docs/research/contentlayer2.md) | Turbopack reproduced; the Chunk leak; why Effect-TS prevented rescue |
| [landscape.md](docs/research/landscape.md) | Astro 7's Loader API, Nuxt Content v3, Standard Schema 1.1, every framework's hook |
| [primitives.md](docs/research/primitives.md) | Measured: globbing, watching, YAML, renderers, images, config loading |
| [ecosystem-health.md](docs/research/ecosystem-health.md) | Downloads, maintenance, and the benchmarks that don't exist |

## License

MIT
