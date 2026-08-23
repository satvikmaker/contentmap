import { describe, expect, it } from 'vitest'
import { markdown } from '../../markdown/src/index.ts'
import { shiki } from '../src/index.ts'

const meta = {
  id: 'a',
  filePath: 'a.md',
  fileName: 'a.md',
  directory: '.',
  extension: '.md',
  path: 'a',
  slug: 'a',
  digest: 'x'
}

/** Render a document through the default renderer with highlighting on. */
async function render(body: string, options?: Parameters<typeof shiki>[0]): Promise<string> {
  const renderer = markdown({ extensions: [await shiki(options)] })
  return String(await renderer.toHtml({ body, path: '/a.md', meta }))
}

describe('shiki highlighting', () => {
  it('colours a language it knows', async () => {
    const html = await render('```ts\nconst answer: number = 42\n```')

    expect(html).toContain('class="shiki')
    // Tokens carry colours, which is the entire point.
    expect(html).toMatch(/<span style="color:#[0-9A-Fa-f]{6}">const/)
  })

  it('renders an unknown language rather than failing the build', async () => {
    // ```mermaid in a corpus of a thousand documents must not fail a build over
    // a missing grammar. It is content, not a configuration error.
    const html = await render('```mermaid\ngraph TD; A-->B;\n```')

    expect(html).toContain('graph TD')
    expect(html).toContain('class="shiki')
  })

  it('renders a fence with no language at all', async () => {
    const html = await render('```\nplain text here\n```')

    expect(html).toContain('plain text here')
  })

  it('emits CSS variables for a light/dark pair', async () => {
    // A build-time highlighter has already committed to a palette. Variables
    // are what let the page switch without re-highlighting.
    const html = await render('```ts\nconst a = 1\n```', {
      theme: { light: 'github-light', dark: 'github-dark' }
    })

    expect(html).toContain('--shiki-dark')
  })

  it('loads only the languages asked for', async () => {
    // Every grammar is parsed and held in memory, so the default list is short
    // and an explicit one has to actually narrow it.
    const html = await render('```python\nx = 1\n```', { langs: ['typescript'] })

    // Rendered as plain text, since python was not loaded.
    expect(html).toContain('x = 1')
    expect(html).not.toMatch(/<span style="color:#[0-9A-Fa-f]{6}">x<\/span>/)
  })

  it('leaves prose untouched', async () => {
    const html = await render('# Heading\n\nSome **bold** prose.\n')

    expect(html).toContain('<h1')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).not.toContain('class="shiki')
  })

  it('keeps inline code out of it', async () => {
    // Inline `code` is not a fence and has no language; highlighting it would
    // wrap every backtick in a <pre>.
    const html = await render('Use `npm install` to begin.')

    expect(html).toContain('<code>npm install</code>')
    expect(html).not.toContain('class="shiki')
  })

  it('honours a language alias', async () => {
    // `js` and `javascript` are the same grammar, and people write both.
    const html = await render('```js\nconst a = 1\n```')

    expect(html).toMatch(/<span style="color:#[0-9A-Fa-f]{6}">const/)
  })
})
