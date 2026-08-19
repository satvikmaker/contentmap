import { Marked, type MarkedExtension } from 'marked'
import type { Renderer, RenderInput } from 'contentmap'

export interface MarkdownOptions {
  /** GitHub Flavored Markdown. Default true. */
  gfm?: boolean
  /** Convert single newlines to <br>. Default false, matching CommonMark. */
  breaks?: boolean
  /** Add an `id` to every heading so anchors and the TOC agree. Default true. */
  headingIds?: boolean
  /** marked extensions, applied in order. */
  extensions?: readonly MarkedExtension[]
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm

/**
 * The default contentmap renderer.
 *
 * marked is one package with zero transitive dependencies, which is the whole
 * argument: a content tool's renderer is the component most likely to be
 * load-bearing for correctness, and this one has nothing underneath it to
 * audit. Reach for `@contentmap/unified` when you need the remark ecosystem.
 */
export function markdown(options: MarkdownOptions = {}): Renderer {
  const headingIds = options.headingIds ?? true
  const marked = new Marked({
    gfm: options.gfm ?? true,
    breaks: options.breaks ?? false,
    async: false
  })
  if (options.extensions) marked.use(...options.extensions)
  if (headingIds) marked.use(headingIdExtension())

  return {
    name: 'marked',
    toHtml(input: RenderInput): string {
      return marked.parse(input.body) as string
    },
    // Reading headings from the source skips a full render for callers that
    // only want a table of contents.
    headings(input: RenderInput) {
      const seen = new Map<string, number>()
      const out: { depth: number; text: string; id: string }[] = []
      for (const match of input.body.matchAll(HEADING)) {
        const text = stripInline(match[2] ?? '')
        if (text === '') continue
        out.push({ depth: (match[1] ?? '#').length, text, id: uniqueSlug(text, seen) })
      }
      return out
    }
  }
}

function headingIdExtension(): MarkedExtension {
  const seen = new Map<string, number>()
  return {
    hooks: {
      preprocess(source: string) {
        seen.clear()
        return source
      }
    },
    renderer: {
      heading(token) {
        const text = stripInline(token.text)
        const id = uniqueSlug(text, seen)
        // `this.parser` renders inline markup inside the heading.
        const inner = (this as unknown as { parser: { parseInline(t: unknown): string } }).parser
          .parseInline(token.tokens)
        return `<h${token.depth} id="${escapeAttr(id)}">${inner}</h${token.depth}>\n`
      }
    }
  }
}

/** Remove inline markdown so a heading slug matches its visible text. */
function stripInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .trim()
}

function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

function uniqueSlug(text: string, seen: Map<string, number>): string {
  const base = slugify(text) || 'section'
  const count = seen.get(base) ?? 0
  seen.set(base, count + 1)
  return count === 0 ? base : `${base}-${count}`
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

export default markdown
