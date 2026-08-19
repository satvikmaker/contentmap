/**
 * Rewrite relative asset URLs in rendered HTML.
 *
 * Done as an HTML pass rather than a remark/rehype plugin so it works with any
 * renderer. Velite implements it twice — once in remark, once in rehype — and
 * the two copies disagree, which is how the attribute bug below survived.
 */

/** Attributes that address a resource. */
const URL_ATTRIBUTES = ['src', 'href', 'poster', 'data-src'] as const

const TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>`]+))/g

export interface RewriteResult {
  html: string
  /** Every source path the document referenced. */
  referenced: string[]
}

export interface RewriteHandlers {
  /** Resolve one URL. Return undefined to leave it untouched. */
  resolve(url: string, attribute: string, tag: string): Promise<ResolvedAsset | undefined>
}

export interface ResolvedAsset {
  src: string
  sourcePath: string
  width?: number
  height?: number
}

/**
 * Rewrite each URL attribute independently.
 *
 * The independence is the point. Velite collects the linked elements for a URL
 * and then writes that one URL into EVERY url-bearing attribute of each
 * element, with no check that the attribute is the one that matched:
 *
 *     <video poster="img.png" src="clip.mp4">
 *     -> <video poster="/clip-08fc.mp4" src="/clip-08fc.mp4">
 *
 * The poster is destroyed. The bug is still present on their unmerged branch.
 */
export async function rewriteHtml(
  html: string,
  handlers: RewriteHandlers
): Promise<RewriteResult> {
  const referenced = new Set<string>()
  const tags = [...html.matchAll(TAG)]
  if (tags.length === 0) return { html, referenced: [] }

  const replacements: { start: number; end: number; text: string }[] = []

  for (const tagMatch of tags) {
    const tagName = (tagMatch[1] ?? '').toLowerCase()
    const attrs = tagMatch[2] ?? ''
    const attrsStart = tagMatch.index + 1 + (tagMatch[1] ?? '').length
    const edits: { start: number; end: number; text: string }[] = []
    let width: number | undefined
    let height: number | undefined
    let hasWidth = false
    let hasHeight = false

    for (const attr of attrs.matchAll(ATTRIBUTE)) {
      const name = (attr[1] ?? '').toLowerCase()
      if (name === 'width') hasWidth = true
      if (name === 'height') hasHeight = true

      const quoted = attr[3] ?? attr[4]
      const raw = quoted ?? attr[5] ?? ''
      const valueStart = attrsStart + attr.index + attr[0].length - (attr[2] ?? '').length +
        (quoted === undefined ? 0 : 1)

      if (name === 'srcset') {
        const rewritten = await rewriteSrcset(raw, handlers, referenced)
        if (rewritten !== raw) {
          edits.push({ start: valueStart, end: valueStart + raw.length, text: escapeAttr(rewritten) })
        }
        continue
      }
      if (!(URL_ATTRIBUTES as readonly string[]).includes(name)) continue

      const resolved = await handlers.resolve(decodeAttr(raw), name, tagName)
      if (!resolved) continue
      referenced.add(resolved.sourcePath)
      // Only this attribute is touched; its siblings keep their own URLs.
      edits.push({ start: valueStart, end: valueStart + raw.length, text: escapeAttr(resolved.src) })
      if (name === 'src' && tagName === 'img') {
        width = resolved.width
        height = resolved.height
      }
    }

    replacements.push(...edits)

    // Intrinsic dimensions prevent layout shift, and no other tool in this
    // space emits them for images inside the body (velite issue #98, open
    // since 2024).
    if (tagName === 'img' && width !== undefined && height !== undefined && !hasWidth && !hasHeight) {
      const insertAt = attrsStart + attrs.length
      replacements.push({ start: insertAt, end: insertAt, text: ` width="${width}" height="${height}"` })
    }
  }

  if (replacements.length === 0) return { html, referenced: [...referenced].sort() }

  replacements.sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const edit of replacements) {
    out += html.slice(cursor, edit.start) + edit.text
    cursor = edit.end
  }
  out += html.slice(cursor)
  return { html: out, referenced: [...referenced].sort() }
}

/** `a.png 1x, b.png 2x` — each candidate resolved on its own. */
async function rewriteSrcset(
  value: string,
  handlers: RewriteHandlers,
  referenced: Set<string>
): Promise<string> {
  const parts = value.split(',')
  const out: string[] = []
  let changed = false
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const space = trimmed.search(/\s/)
    const url = space === -1 ? trimmed : trimmed.slice(0, space)
    const descriptor = space === -1 ? '' : trimmed.slice(space)
    const resolved = await handlers.resolve(decodeAttr(url), 'srcset', 'img')
    if (resolved) {
      referenced.add(resolved.sourcePath)
      out.push(resolved.src + descriptor)
      changed = true
    } else {
      out.push(trimmed)
    }
  }
  return changed ? out.join(', ') : value
}

function decodeAttr(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}
