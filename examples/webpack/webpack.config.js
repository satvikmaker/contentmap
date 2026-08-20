import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ContentmapWebpackPlugin from '@contentmap/webpack'

const here = dirname(fileURLToPath(import.meta.url))

// No resolve.alias: the plugin registers `contentmap/generated` itself.
export default {
  entry: resolve(here, 'src/index.js'),
  output: { path: resolve(here, 'dist'), filename: 'main.js' },
  plugins: [new ContentmapWebpackPlugin()],
  experiments: { outputModule: true }
}
