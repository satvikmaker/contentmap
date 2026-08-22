import { describe, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { run } from '@mdx-js/mdx'
import { createBuilder } from '../../contentmap/src/index.ts'
import { fixtureTest } from '../../contentmap/test/helpers.ts'

const SRC = pathToFileURL(resolve(import.meta.dirname, '../../contentmap/src/index.ts')).href
const MDX = pathToFileURL(resolve(import.meta.dirname, '../src/index.ts')).href

const CONFIG = `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}
import { mdx } from ${JSON.stringify(MDX)}
import { z } from 'zod'
const posts = defineCollection({
  directory: 'content', include: '**/*.mdx',
  schema: z.object({ title: z.string(), content: z.string() }),
  transform: async (doc, ctx) => ({ ...doc, code: await ctx.mdx() })
})
export default defineConfig({ mdx: mdx(), collections: { posts } })
`

const runtime = {
  Fragment: 'fragment',
  jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
  jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props })
}

describe('mdx through a real build', () => {
  fixtureTest('compiles a document and the code survives emission', async ({ fixture }) => {
    // The compiled body is a string, which is the whole reason this design
    // works: a data module can hold it, and the serializer does not have to
    // learn about functions.
    await fixture.write('contentmap.config.ts', CONFIG)
    await fixture.write(
      'content/post.mdx',
      '---\ntitle: Hi\n---\n\nexport const answer = 42\n\n# Value {answer}\n'
    )

    const result = await createBuilder({ root: fixture.dir }).build()
    expect(result.errors).toBe(0)

    const module = await import(
      `${pathToFileURL(join(fixture.dir, '.contentmap/posts/post.js')).href}?t=${Date.now()}`
    )
    const compiled = (module.default as { code: string }).code
    const mdxModule = (await run(compiled, {
      ...(runtime as never),
      baseUrl: import.meta.url
    })) as { answer: number; default: unknown }

    expect(typeof mdxModule.default).toBe('function')
    expect(mdxModule.answer).toBe(42)
  })

  fixtureTest('names the file when the MDX will not parse', async ({ fixture }) => {
    // MDX puts the location on the error, not in the message. Without the
    // filename around it, a corpus-wide failure is unsearchable.
    await fixture.write('contentmap.config.ts', CONFIG)
    await fixture.write('content/broken.mdx', '---\ntitle: Broken\n---\n\n<Unclosed>\n')

    const result = await createBuilder({ root: fixture.dir }).build()

    expect(result.errors).toBe(1)
    const diagnostic = result.diagnostics.find(d => d.code === 'CM_TRANSFORM')
    expect(diagnostic?.file).toBe('broken.mdx')
    expect(diagnostic?.message).toContain('closing tag')
  })

  fixtureTest('says what to install when no compiler is configured', async ({ fixture }) => {
    // ctx.mdx() without `mdx:` in the config is the mistake everyone makes
    // once. It has to name the package and the option.
    await fixture.write(
      'contentmap.config.ts',
      `import { defineConfig, defineCollection } from ${JSON.stringify(SRC)}
import { z } from 'zod'
const posts = defineCollection({
  directory: 'content', include: '**/*.mdx',
  schema: z.object({ title: z.string(), content: z.string() }),
  transform: async (doc, ctx) => ({ ...doc, code: await ctx.mdx() })
})
export default defineConfig({ collections: { posts } })
`
    )
    await fixture.write('content/post.mdx', '---\ntitle: Hi\n---\n\n# Hello\n')

    const result = await createBuilder({ root: fixture.dir }).build()

    expect(result.errors).toBe(1)
    const message = result.diagnostics.map(d => `${d.message} ${d.hint ?? ''}`).join('\n')
    expect(message).toContain('ctx.mdx()')
    expect(message).toContain('@contentmap/mdx')
  })
})
