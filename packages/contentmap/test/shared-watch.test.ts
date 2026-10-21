import { once } from 'node:events'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { watch } from 'chokidar'
import { expect, vi } from 'vitest'
import { createBuilder } from '../src/builder.ts'
import { startWatch } from '../src/watch/index.ts'
import { fixtureTest } from './helpers.ts'

const SRC = pathToFileURL(resolve(import.meta.dirname, '../src/index.ts')).href

fixtureTest(
  'filters shared watcher events using the current watched paths',
  async ({ fixture }) => {
    await fixture.write(
      'contentmap.config.ts',
      `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}
import { z } from 'zod'
export default defineConfig({ collections: {
  posts: defineCollection({ directory: 'content', include: '**/*.md', schema: z.object({}) })
} })`
    )
    const content = await fixture.write('content/note.md', 'Body')
    const unrelated = await fixture.write('app.ts', 'export {}')
    const sibling = await fixture.write('content-other/note.md', 'Other')
    const dependency = await fixture.write('settings.ts', 'export {}')
    const extra = await fixture.write('templates/post.html', '<article>Body</article>')
    const extraSibling = await fixture.write('templates/post.html.bak', 'Backup')
    const builder = createBuilder({ root: fixture.dir })
    const result = await builder.build()
    expect(result.errors).toBe(0)
    const config = { ...(await builder.resolve()), configDeps: [dependency] }
    const watcher = watch(fixture.dir, { ignoreInitial: true })
    await once(watcher, 'ready')
    const rebuild = vi.fn(async (_changed: ReadonlySet<string>, _reason: string) => result)
    const reload = vi.fn(async (_path: string) => result)
    const handle = await startWatch(config, { rebuild, reload, logger: console }, { watcher })

    // Deliver known events after the real shared watcher is ready. No file writes
    // race with Chokidar, and the content event is the positive control for each batch.
    const change = (path: string): void => {
      watcher.emit('all', 'change', path)
    }
    const expectRebuild = async (count: number, path: string): Promise<void> => {
      await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(count))
      expect(rebuild.mock.calls[count - 1]?.[0]).toEqual(new Set([path]))
    }

    try {
      change(unrelated)
      change(sibling)
      change(content)
      await expectRebuild(1, content)

      change(config.configPath)
      await vi.waitFor(() => expect(reload).toHaveBeenCalledWith(config.configPath))
      change(dependency)
      await vi.waitFor(() => expect(reload).toHaveBeenCalledWith(dependency))

      handle.sync(config, [extra])
      change(extraSibling)
      change(extra)
      await expectRebuild(2, extra)

      const next = {
        ...config,
        collections: {
          posts: { ...config.collections['posts']!, directory: join(fixture.dir, 'content-other') }
        }
      }
      handle.sync(next)
      change(extra)
      change(content)
      change(sibling)
      await expectRebuild(3, sibling)
    } finally {
      await handle.close()
      await watcher.close()
      await builder.close()
    }
  }
)
