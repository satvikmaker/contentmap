# @contentmap/webpack

The [webpack](https://webpack.js.org) and [Rspack](https://rspack.dev) plugin for [contentmap](https://github.com/satvikmaker/contentmap).

For Next.js, use [@contentmap/next](https://github.com/satvikmaker/contentmap/tree/main/packages/next) instead — it handles Turbopack too.

## Install

```sh
npm i @contentmap/webpack
```

## Use

```js
// webpack.config.js
const ContentmapWebpackPlugin = require('@contentmap/webpack')

module.exports = {
  plugins: [new ContentmapWebpackPlugin()]
}
```

Content builds before the first compilation and rebuilds in watch mode. Rspack uses the same plugin — the hooks are compatible.

The plugin registers the `contentmap/generated` alias for you, because webpack does not read tsconfig paths. An alias you set yourself is never overwritten.

```js
import { posts } from 'contentmap/generated'
```

## Options

```js
new ContentmapWebpackPlugin({ config: 'contentmap.config.ts' })
```

Every [`BuilderOptions`](https://github.com/satvikmaker/contentmap#configuration) field is accepted.

## Links

- [contentmap documentation](https://github.com/satvikmaker/contentmap#readme)
- [Report an issue](https://github.com/satvikmaker/contentmap/issues)

MIT
