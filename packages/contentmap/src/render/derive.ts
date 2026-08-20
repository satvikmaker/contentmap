import type { Heading, ReadingTime, ReadingTimeOptions, TocEntry, TocOptions } from '../types.ts'

/**
 * Derivations computed from rendered HTML.
 *
 * Working from HTML rather than a renderer-specific AST is what lets a minimal
 * renderer be a single `toHtml` function: plain text, headings and everything
 * built on them fall out for free, identically across engines.
 */

const VOID_TEXT = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi
const TAG = /<[^>]+>/g
const HEADING = /<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1>/gi
const ID_ATTR = /\bid\s*=\s*["']([^"']*)["']/i

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013'
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** Strip markup, collapse whitespace. Block tags become spaces, not joins. */
export function htmlToPlain(html: string): string {
  return decodeEntities(
    html
      .replace(VOID_TEXT, ' ')
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article)>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(TAG, '')
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/** Extract headings, preferring an `id` the renderer already emitted. */
export function htmlToHeadings(html: string): Heading[] {
  const out: Heading[] = []
  const seen = new Map<string, number>()
  for (const match of html.matchAll(HEADING)) {
    const depth = Number(match[1])
    const attrs = match[2] ?? ''
    const text = htmlToPlain(match[3] ?? '')
    if (text === '') continue
    const explicit = ID_ATTR.exec(attrs)?.[1]
    out.push({ depth, text, id: explicit ?? uniqueSlug(text, seen) })
  }
  return out
}

/**
 * GitHub-compatible slug.
 *
 * Matches `github-slugger` for the cases that matter, without the dependency:
 * lowercase, strip punctuation, spaces to hyphens, numeric suffix on collision.
 */
export function slugify(text: string): string {
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

/** Nest a flat heading list into a tree, filtered by depth. */
export function buildToc(headings: readonly Heading[], options: TocOptions = {}): TocEntry[] {
  const min = options.minDepth ?? 2
  const max = options.maxDepth ?? 3
  const root: TocEntry[] = []
  const stack: TocEntry[] = []

  for (const heading of headings) {
    if (heading.depth < min || heading.depth > max) continue
    const entry: TocEntry = {
      depth: heading.depth,
      text: heading.text,
      id: heading.id,
      children: []
    }
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= entry.depth) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(entry)
    else root.push(entry)
    stack.push(entry)
  }
  return root
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/gu
const WORD = /[\p{L}\p{N}]+(?:['\u2019][\p{L}]+)*/gu

/**
 * Reading time.
 *
 * CJK has no spaces, so word-splitting undercounts it badly; characters are
 * counted individually and weighted instead. 265 wpm is the constant Gatsby
 * popularised and every tool in this space now uses.
 */
export function readingTimeOf(plain: string, options: ReadingTimeOptions = {}): ReadingTime {
  const wpm = options.wpm ?? 265
  const cjk = plain.match(CJK)?.length ?? 0
  const latin = plain.replace(CJK, ' ').match(WORD)?.length ?? 0
  const words = latin + Math.round(cjk * 0.56)
  return {
    minutes: Math.max(1, Math.ceil(words / wpm)),
    words,
    characters: plain.length
  }
}

export const DEFAULT_EXCERPT_SEPARATOR = '<!--more-->'

/**
 * Truncate plain text on a word boundary.
 *
 * Velite slices the raw string at a byte offset, so it routinely ends mid-word.
 * Input must already be plain text — honouring an explicit cut marker needs the
 * renderer and is handled by the transform context.
 */
export function excerptOf(plain: string, options: { length?: number } = {}): string {
  const length = options.length ?? 260
  if (plain.length <= length) return plain

  const window = plain.slice(0, length + 1)
  const lastSpace = window.lastIndexOf(' ')
  const cut = lastSpace > length * 0.6 ? lastSpace : length
  return `${plain.slice(0, cut).replace(/[\s,;:.\u2013\u2014-]+$/, '')}\u2026`
}
