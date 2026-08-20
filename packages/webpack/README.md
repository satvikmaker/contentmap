# @contentmap/webpack

The [webpack](https://webpack.js.org) and [Rspack](https://rspack.dev) plugin for [contentmap](https://github.com/contentmap/contentmap).

For Next.js, use [@contentmap/next](https://github.com/contentmap/contentmap/tree/main/packages/next) instead — it handles Turbopack too.

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

## Options

```js
new ContentmapWebpackPlugin({ config: 'contentmap.config.ts' })
```

Every [`BuilderOptions`](https://github.com/contentmap/contentmap#configuration) field is accepted.

## Links

- [contentmap documentation](https://github.com/contentmap/contentmap#readme)
- [Report an issue](https://github.com/contentmap/contentmap/issues)

MIT
