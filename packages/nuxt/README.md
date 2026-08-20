# @contentmap/nuxt

The [Nuxt](https://nuxt.com) module for [contentmap](https://github.com/contentmap/contentmap).

## Install

```sh
npm i @contentmap/nuxt
```

## Use

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@contentmap/nuxt']
})
```

Content builds before Nitro resolves modules, rebuilds on change in dev, and the `contentmap/generated` alias is registered for you.

```vue
<script setup lang="ts">
import { posts } from 'contentmap/generated'
</script>
```

## Options

```ts
export default defineNuxtConfig({
  modules: ['@contentmap/nuxt'],
  contentmap: {
    config: 'contentmap.config.ts'
  }
})
```

Every [`BuilderOptions`](https://github.com/contentmap/contentmap#configuration) field is accepted.

## Links

- [contentmap documentation](https://github.com/contentmap/contentmap#readme)
- [Report an issue](https://github.com/contentmap/contentmap/issues)

MIT
