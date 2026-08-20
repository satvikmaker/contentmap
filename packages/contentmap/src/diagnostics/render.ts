import type { Diagnostic } from '../types.ts'
import { blue, bold, cyan, dim, gray, red, yellow } from '../utils/ansi.ts'
import type { DiagnosticBag } from './bag.ts'

export interface RenderOptions {
  /** Total documents scanned, for the corpus summary. */
  total: number
  /** Files shown per group before collapsing. */
  limit?: number
}

const TITLES: Record<string, string> = {
  CM_VALIDATION: 'Validation',
  CM_PARSE: 'Parse',
  CM_READ: 'Read',
  CM_UNKNOWN_FIELD: 'Unknown field',
  CM_DUPLICATE_ID: 'Duplicate id',
  CM_SINGLETON: 'Singleton',
  CM_MISSING_REF: 'Missing reference',
  CM_CONFIG: 'Configuration',
  CM_NO_MATCH: 'No matching files',
  CM_SERIALIZE: 'Not serializable',
  CM_TRANSFORM: 'Transform',
  CM_SKIPPED: 'Skipped'
}

const TICK_ERROR = '\u2716'
const TICK_WARN = '\u26a0'
const TICK_INFO = '\u2139'
const BRANCH = '\u251c\u2500'
const LAST = '\u2514\u2500'
const PIPE = '\u2502'

/**
 * Group diagnostics by kind, then by file, and print a corpus-level summary.
 *
 * This is contentlayer's model, which the newer tools regressed on. For a
 * 5,000-document corpus, "37 documents have problems, grouped by kind; the
 * other 4,963 built fine" is categorically more useful than a wall of validator
 * issues that stops at the first failure.
 */
export function renderDiagnostics(bag: DiagnosticBag, options: RenderOptions): string {
  const items = bag.sorted()
  if (items.length === 0) return ''

  const limit = options.limit ?? 10
  const errors = bag.errors
  const warnings = bag.warnings

  // Count the corpus, not the survivors: "0 documents" when everything failed
  // reads as though nothing was even scanned.
  const affected = new Set(
    items.filter(d => d.file ?? d.documentId).map(d => d.file ?? d.documentId)
  ).size
  const ok = Math.max(0, options.total - affected)

  // An `info`-only report is not a warning. Announcing "0 errors, 0 warnings"
  // under a warning glyph tells the reader something went wrong when nothing
  // did — a skipped draft is the system working as configured.
  const icon = errors > 0 ? red(TICK_ERROR) : warnings > 0 ? yellow(TICK_WARN) : blue(TICK_INFO)
  const counts =
    errors > 0 || warnings > 0
      ? count(errors, 'error') + ', ' + count(warnings, 'warning')
      : count(items.length, 'note')

  const lines: string[] = [
    icon +
      ' contentmap ' +
      dim('\u2014') +
      ' ' +
      counts +
      ' ' +
      'in ' +
      plural(options.total, 'document') +
      ' ' +
      dim('(' + ok.toLocaleString() + ' ok)'),
    ''
  ]

  for (const [code, group] of groupBy(items, d => d.code)) {
    const worst = group.some(d => d.severity === 'error')
      ? 'error'
      : group.some(d => d.severity === 'warning')
        ? 'warning'
        : 'info'
    const label = TITLES[code] ?? code
    const suffix = worst === 'error' ? '' : worst === 'warning' ? ', warn' : ', info'
    lines.push('  ' + bold(label) + ' ' + dim('(' + group.length + suffix + ')'))

    const files = [...groupBy(group, d => d.file ?? d.documentId ?? '(unknown)')]
    const shown = files.slice(0, limit)

    shown.forEach(([file, ds], i) => {
      const last = i === shown.length - 1 && files.length <= limit
      lines.push('  ' + (last ? LAST : BRANCH) + ' ' + cyan(file) + location(ds[0]))
      const gutter = last ? '     ' : '  ' + gray(PIPE) + '  '
      for (const d of ds) {
        const field = d.field ? bold(pad(d.field, 12)) : ' '.repeat(12)
        lines.push(gutter + field + ' ' + d.message)
        if (d.hint) lines.push(gutter + ' '.repeat(12) + ' ' + dim(d.hint))
        if (d.frame) {
          for (const frameLine of d.frame.split('\n')) {
            lines.push(gutter + ' '.repeat(12) + ' ' + dim(frameLine))
          }
        }
      }
    })

    if (files.length > limit) {
      lines.push('  ' + LAST + ' ' + dim('\u2026and ' + (files.length - limit) + ' more file(s)'))
    }
    lines.push('')
  }

  return lines.join('\n')
}

function location(d: Diagnostic | undefined): string {
  if (!d?.line) return ''
  return dim(':' + d.line + (d.column ? ':' + d.column : ''))
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = out.get(k)
    if (list) list.push(item)
    else out.set(k, [item])
  }
  return out
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text.padEnd(width)
}

function count(n: number, word: string): string {
  return n + ' ' + word + (n === 1 ? '' : 's')
}

function plural(n: number, word: string): string {
  return n.toLocaleString() + ' ' + word + (n === 1 ? '' : 's')
}
