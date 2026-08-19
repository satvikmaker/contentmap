import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // forks is the v4 default and the right choice: only forks/vmForks support
    // process.chdir(), and the threads pool can segfault with native deps.
    pool: 'forks',
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 20_000
  }
})
