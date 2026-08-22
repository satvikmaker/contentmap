import { describe, expect, it } from 'vitest'
import { run } from '@mdx-js/mdx'
import { mdx } from '../src/index.ts'

/**
 * The three functions `run()` needs, and nothing else.
 *
 * Hand-rolled rather than React's: this package is framework-agnostic, and a
 * test that pulls React in would quietly stop proving that.
 */
const runtime = {
  Fragment: 'fragment',
  jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
  jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props })
}

const input = (body: string) => ({
  body,
  path: '/project/content/post.mdx',
  meta: {
    id: 'post',
    filePath: 'post.mdx',
    fileName: 'post.mdx',
    directory: '.',
    extension: '.mdx',
    path: 'post',
    slug: 'post',
    digest: 'x'
  }
})

describe('mdx compiler', () => {
  it('emits a function body, not a program', async () => {
    // A build can write data, and a component does not exist until a JSX
    // runtime has evaluated it. `program` output would carry bare `import`
    // statements that no data module can hold.
    const code = await mdx().compile(input('# Hello'))

    expect(code).toContain('return')
    expect(code).not.toMatch(/^import .* from/m)
  })

  it('round-trips through run() into a component', async () => {
    const code = await mdx().compile(input('# Hello'))

    const mod = await run(code, { ...(runtime as never), baseUrl: import.meta.url })

    expect(typeof mod.default).toBe('function')
  })

  it('keeps named exports and expressions', async () => {
    // These are the two things MDX has that markdown does not; losing either
    // makes the compiler pointless.
    const code = await mdx().compile(input('export const answer = 42\n\n# Value {answer}'))

    const mod = (await run(code, { ...(runtime as never), baseUrl: import.meta.url })) as {
      answer: number
    }

    expect(mod.answer).toBe(42)
  })

  it('accepts remark plugins', async () => {
    const seen: string[] = []
    const plugin = () => (tree: unknown) => {
      seen.push(typeof tree)
    }

    await mdx({ remarkPlugins: [plugin] }).compile(input('# Hello'))

    expect(seen).toEqual(['object'])
  })

  it('lets a call override the configured options', async () => {
    // Mirrors `ctx.markdown(options)`: a caller asking for different output
    // should get it rather than whatever the config settled on.
    const configured: string[] = []
    const perCall: string[] = []
    const spy = (into: string[]) => () => () => void into.push('ran')

    const compiler = mdx({ remarkPlugins: [spy(configured)] })
    await compiler.compile(input('# A'))
    await compiler.compile(input('# B'), { remarkPlugins: [spy(perCall)] })

    expect(configured).toHaveLength(1)
    expect(perCall).toHaveLength(1)
  })

  it('rejects a syntax error with a position', async () => {
    // An unclosed tag is the commonest MDX mistake. MDX puts the file on the
    // error object rather than in the message; what the message must carry is
    // where in the document to look. contentmap supplies the filename around
    // it — asserted in the integration test below.
    await expect(mdx().compile(input('<Broken>'))).rejects.toThrow(/closing tag.*\(\d+:\d+/)
  })

  it('builds a baseUrl even for a path with spaces', async () => {
    // MDX v3 requires baseUrl for function-body output, and an unescaped space
    // makes it an invalid URL.
    await expect(
      mdx().compile({ ...input('# Hello'), path: '/project/my content/post.mdx' })
    ).resolves.toContain('return')
  })
})
