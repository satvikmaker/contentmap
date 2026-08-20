# @contentmap/next

The [Next.js](https://nextjs.org) integration for [contentmap](https://github.com/contentmap/contentmap). Works on **both Turbopack and webpack**.

## Install

```sh
npm i @contentmap/next
```

## Use

```ts
// next.config.ts
import { withContentmap } from '@contentmap/next'

export default withContentmap({
  // your Next config
})
```

Content builds before the first compile and watches in `next dev`.

## Turbopack

Turbopack has no plugin API, so `withContentmap` builds content before Next starts rather than from inside the bundler. The practical difference is none: output lands on disk either way, and `next dev` watches it.

Add the path alias to your `tsconfig.json` so imports resolve — `contentmap init` does this for you:

```json
{
  "compilerOptions": {
    "paths": { "contentmap/generated": ["./.contentmap"] }
  }
}
```

```ts
import { posts } from 'contentmap/generated'
```

## Options

Every [`BuilderOptions`](https://github.com/contentmap/contentmap#configuration) field is accepted alongside your Next config.

## Links

- [contentmap documentation](https://github.com/contentmap/contentmap#readme)
- [Report an issue](https://github.com/contentmap/contentmap/issues)

MIT
