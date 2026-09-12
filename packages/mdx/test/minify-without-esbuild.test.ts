import { describe, expect, it, vi } from 'vitest'

// The option's whole bargain is that esbuild is optional, so the path where it
// is missing is the one a user who turns `minify` on without it will hit.
vi.mock('esbuild', () => {
  throw new Error("Cannot find package 'esbuild'")
})

const { mdx } = await import('../src/index.ts')

const input = {
  body: '# Hello',
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
}

describe('minify without esbuild', () => {
  it('names the package to install rather than failing as a missing module', async () => {
    await expect(mdx({ minify: true }).compile(input)).rejects.toThrow(
      /minify requires the `esbuild` package/
    )
  })

  it('still compiles with the option off', async () => {
    await expect(mdx().compile(input)).resolves.toContain('_createMdxContent')
  })
})
