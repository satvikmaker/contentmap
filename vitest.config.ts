import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      {
        // The adapter packages import `contentmap` by name, which resolved
        // through the built dist and made this suite depend on `pnpm build`
        // having run — a stale dist silently reports a fixed bug as still
        // broken. On Windows it is worse: Vite cannot follow pnpm's junction
        // to the package entry at all, and the whole suite fails to load.
        // Every other test file already imports `../src`; this makes the
        // adapters agree. The built package is covered by verify:types and by
        // the example applications, which is where it belongs.
        //
        // Anchored, because a bare string alias also matches prefixes and
        // would rewrite `contentmap/runtime` into a path inside index.ts.
        find: /^contentmap$/,
        replacement: fileURLToPath(new URL('./packages/contentmap/src/index.ts', import.meta.url))
      }
    ]
  },
  test: {
    // forks is the v4 default and the right choice: only forks/vmForks support
    // process.chdir(), and the threads pool can segfault with native deps.
    pool: 'forks',
    include: ['packages/*/test/**/*.test.ts'],
    typecheck: {
      enabled: true,
      include: ['packages/*/test/**/*.test-d.ts'],
      tsconfig: './packages/contentmap/tsconfig.json'
    },
    testTimeout: 20_000
  }
})
