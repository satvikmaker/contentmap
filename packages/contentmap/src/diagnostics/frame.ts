/**
 * Source excerpts for diagnostics.
 *
 * Naming the file and field tells you where to look; showing the line tells you
 * what is wrong. Velite's `s.isodate()` on a bad date throws a bare
 * `RangeError: Invalid time value` with neither, which on a large corpus is a
 * needle in a haystack.
 */

export interface Position {
  line: number
  column?: number
}

const GUTTER = 2

/** Render up to `GUTTER` lines of context around `line`, with a caret. */
export function codeFrame(source: string, pos: Position, maxWidth = 100): string {
  const lines = source.split(/\r?\n/)
  const target = Math.max(1, Math.min(pos.line, lines.length))
  const from = Math.max(1, target - GUTTER)
  const to = Math.min(lines.length, target + GUTTER)
  const width = String(to).length

  const out: string[] = []
  for (let n = from; n <= to; n++) {
    const text = truncate(lines[n - 1] ?? '', maxWidth)
    const marker = n === target ? '>' : ' '
    out.push(`${marker} ${String(n).padStart(width)} | ${text}`)
    if (n === target && pos.column !== undefined && pos.column > 0) {
      const caretPad = ' '.repeat(Math.min(pos.column - 1, maxWidth))
      out.push(`  ${' '.repeat(width)} | ${caretPad}^`)
    }
  }
  return out.join('\n')
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * Find the line a top-level frontmatter key sits on.
 *
 * A validator reports the field path but knows nothing about the file, so this
 * is what turns `title: too long` into a caret on the offending line.
 */
export function findKeyPosition(source: string, field: string): Position | undefined {
  const root = field.split(/[.[]/)[0]
  if (!root) return undefined
  const lines = source.split(/\r?\n/)
  const pattern = new RegExp(`^(\\s*)(["']?)${escapeRegExp(root)}\\2\\s*:`)
  for (let i = 0; i < lines.length; i++) {
    const match = pattern.exec(lines[i] ?? '')
    if (match) return { line: i + 1, column: (match[1]?.length ?? 0) + 1 }
  }
  return undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Pull a `(line:column)` or `line N, column M` out of a parser error, and strip
 * any code frame the parser embedded in its own message.
 *
 * js-yaml (which confbox vendors) appends a multi-line ASCII frame to
 * `.message`. Left alone it lands inside our tree with foreign indentation and
 * breaks the layout, and it makes `--json` messages multi-line.
 */
export function normalizeParserError(error: unknown): {
  message: string
  position: Position | undefined
} {
  const raw = error instanceof Error ? error.message : String(error)
  let position: Position | undefined

  // A parser that already resolved a file-relative position wins: only it
  // knows how far into the file its input started.
  const explicit = error as { line?: unknown; column?: unknown } | null
  if (typeof explicit?.line === 'number') {
    position = {
      line: explicit.line,
      ...(typeof explicit.column === 'number' ? { column: explicit.column } : {})
    }
  }

  const mark = (error as { mark?: { line?: number; column?: number } } | null)?.mark
  if (!position && mark && typeof mark.line === 'number') {
    // js-yaml marks are zero-based.
    position = { line: mark.line + 1, column: (mark.column ?? 0) + 1 }
  }

  const firstLine = raw.split('\n')[0] ?? raw
  let message = firstLine

  const paren = /\((\d+):(\d+)\)\s*$/.exec(firstLine)
  if (paren) {
    position ??= { line: Number(paren[1]), column: Number(paren[2]) }
    message = firstLine.slice(0, paren.index).trim()
  } else {
    const worded = /\bline (\d+),? column (\d+)/i.exec(firstLine)
    if (worded) position ??= { line: Number(worded[1]), column: Number(worded[2]) }
  }

  return { message: message.trim() || raw.trim(), position }
}
