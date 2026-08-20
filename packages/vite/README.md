# @contentmap/vite

The [Vite](https://vite.dev) plugin for [contentmap](https://github.com/satvikmaker/contentmap).

One plugin covers **Vite, SvelteKit, SolidStart, Qwik, React Router, TanStack Start and Analog** — they all build on Vite, so they all take the same integration.

## Install

```sh
npm i @contentmap/vite
```

## Use

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import contentmap from '@contentmap/vite'

export default defineConfig({
  plugins: [contentmap()]
})
```

Content builds before Vite resolves the first module, rebuilds on change in dev, and triggers HMR. The `contentmap/generated` alias is registered for you.

```ts
import { posts } from 'contentmap/generated'
```

## Options

Every [`BuilderOptions`](https://github.com/satvikmaker/contentmap#configuration) field is accepted — `config`, `outDir`, `concurrency`, `onValidationError` and the rest.

## Note

This plugin is a convenience, not a requirement. It runs the same builder as the `contentmap` CLI and produces byte-identical output — a CI job diffs the two to keep that true. If you would rather run `contentmap build` yourself, nothing is lost.

## Links

- [contentmap documentation](https://github.com/satvikmaker/contentmap#readme)
- [Report an issue](https://github.com/satvikmaker/contentmap/issues)

MIT
