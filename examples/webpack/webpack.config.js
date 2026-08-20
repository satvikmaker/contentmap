import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ContentmapWebpackPlugin from '@contentmap/webpack'

const here = dirname(fileURLToPath(import.meta.url))

export default {
  entry: resolve(here, 'src/index.js'),
  output: { path: resolve(here, 'dist'), filename: 'main.js' },
  plugins: [new ContentmapWebpackPlugin()],
  experiments: { outputModule: true },
  resolve: {
    // webpack does not read tsconfig paths.
    alias: { 'contentmap/generated': resolve(here, '.contentmap') }
  }
}
