import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/runtime/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  // package is type:module, so .js already means ESM — avoid .mjs noise
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  clean: true,
  treeshake: true,
  publint: true
})
