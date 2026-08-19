import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'vitest'

export interface Fixture {
  dir: string
  write(relative: string, content: string): Promise<string>
}

/**
 * Temp-dir fixture.
 *
 * The realpath() call is load-bearing on macOS: mkdtemp returns /var/... while
 * the OS reports /private/var/..., so any later path comparison silently fails.
 */
export const fixtureTest = test.extend<{ fixture: Fixture }>({
  // eslint-disable-next-line no-empty-pattern
  fixture: async ({}, use) => {
    const raw = await mkdtemp(join(tmpdir(), 'contentmap-'))
    const dir = await realpath(raw)
    await use({
      dir,
      async write(relative, content) {
        const path = join(dir, relative)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content, 'utf8')
        return path
      }
    })
    await rm(raw, { recursive: true, force: true })
  }
})

export const CONFIG = (body: string): string =>
  `import { defineConfig, defineCollection } from 'contentmap'\nimport { z } from 'zod'\n\n${body}\n`
