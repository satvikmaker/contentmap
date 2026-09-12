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

describe("compat: 'mdx-bundler'", () => {
  /**
   * How contentlayer and content-collections pages evaluate `body.code`:
   * mdx-bundler's `getMDXComponent` passes React, ReactDOM and the JSX runtime
   * as named parameters, rather than the runtime as the first argument.
   */
  const bundler = (code: string): { default: (props: object) => unknown } =>
    new Function('React', 'ReactDOM', '_jsx_runtime', code)({}, {}, runtime)

  const render = async (code: string): Promise<string> => {
    const mod = await run(code, { ...(runtime as never), baseUrl: import.meta.url })
    return JSON.stringify((mod.default as (props: object) => unknown)({}))
  }

  it('renders the same under run() and under getMDXComponent', async () => {
    const code = await mdx({ compat: 'mdx-bundler' }).compile(input('# Hello *there*'))

    const viaBundler = JSON.stringify(bundler(code).default({}))
    expect(viaBundler).toBe(await render(code))
    expect(viaBundler).toContain('there')
  })

  it('is needed: plain output breaks under getMDXComponent', async () => {
    // The first argument there is React, which has no `jsx`. This is what a
    // migrated contentlayer page would hit on its first render.
    const code = await mdx().compile(input('# Hello'))
    expect(() => bundler(code).default({})).toThrow()
  })

  it('leaves a code sample that mentions arguments[0] alone', async () => {
    // Why the body is wrapped rather than having its `arguments[0]` rewritten.
    const code = await mdx({ compat: 'mdx-bundler' }).compile(input('Use `arguments[0]` here'))
    expect(JSON.stringify(bundler(code).default({}))).toContain('arguments[0]')
    expect(await render(code)).toContain('arguments[0]')
  })

  it('keeps named exports under both', async () => {
    const code = await mdx({ compat: 'mdx-bundler' }).compile(input('export const answer = 42'))
    expect((bundler(code) as unknown as { answer: number }).answer).toBe(42)
    const mod = (await run(code, { ...(runtime as never), baseUrl: import.meta.url })) as {
      answer: number
    }
    expect(mod.answer).toBe(42)
  })
})

describe('minify', () => {
  const SOURCE = [
    '# Title',
    '',
    'A paragraph with **bold** text and a [link](https://example.com).',
    '',
    'export const meta = { a: 1 }',
    '',
    '- one',
    '- two',
    ''
  ].join('\n')

  const render = async (code: string): Promise<string> => {
    const mod = await run(code, { ...(runtime as never), baseUrl: import.meta.url })
    return JSON.stringify((mod.default as (props: object) => unknown)({}))
  }

  it('produces smaller output that evaluates identically', async () => {
    // The compiler emits readable JavaScript that nothing reads. velite has
    // always minified, and a migrated 54-document site wrote 2.5× more here
    // than it did there.
    const plain = await mdx().compile(input(SOURCE))
    const small = await mdx({ minify: true }).compile(input(SOURCE))

    expect(small.length).toBeLessThan(plain.length)
    expect(await render(small)).toBe(await render(plain))
  })

  it('keeps the exports the document declares', async () => {
    const code = await mdx({ minify: true }).compile(input(SOURCE))
    const mod = await run(code, { ...(runtime as never), baseUrl: import.meta.url })
    expect(mod.meta).toEqual({ a: 1 })
  })

  it('composes with mdx-bundler compat, which is the migration path', async () => {
    // Minifying after the wrapper means the wrapper is minified too, and the
    // free `_jsx_runtime` it tests for must survive that.
    const code = await mdx({ minify: true, compat: 'mdx-bundler' }).compile(input(SOURCE))
    const viaBundler = new Function('React', 'ReactDOM', '_jsx_runtime', code)({}, {}, runtime) as {
      default: (props: object) => unknown
    }

    expect(JSON.stringify(viaBundler.default({}))).toBe(await render(code))
  })

  it('is off unless asked for', async () => {
    const code = await mdx().compile(input(SOURCE))
    expect(code).toContain('function _createMdxContent')
  })
})
