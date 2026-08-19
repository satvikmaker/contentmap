import { defineConfig } from 'vitest/config'

export default defineConfig({
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
