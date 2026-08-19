import type { Diagnostic, DiagnosticSeverity } from './types.ts'
import { bold, cyan, dim, gray, red, yellow } from './utils/ansi.ts'

/**
 * Collects diagnostics and renders them grouped by code then file.
 *
 * This is deliberately modelled on contentlayer, which is the one area where
 * the incumbents' successors regressed: it reports at corpus level ("37 of
 * 5,000 documents have problems, grouped by kind") rather than dumping a wall
 * of validator issues. Velite by contrast logs a real schema violation at
 * `info` while logging its own advisory note at `warning`.
 */
export class DiagnosticBag {
  readonly items: Diagnostic[] = []

  add(d: Diagnostic): void {
    this.items.push(d)
  }

  get errors(): number {
    return this.items.filter(d => d.severity === 'error').length
  }

  get warnings(): number {
    return this.items.filter(d => d.severity === 'warning').length
  }

  clear(): void {
    this.items.length = 0
  }

  /** Human-facing report. Empty string when there is nothing to say. */
  format(totalDocuments: number): string {
    if (this.items.length === 0) return ''

    const byCode = new Map<string, Diagnostic[]>()
    for (const d of this.items) {
      const list = byCode.get(d.code)
      if (list) list.push(d)
      else byCode.set(d.code, [d])
    }

    const errs = this.errors
    const warns = this.warnings
    const affected = new Set(this.items.map(d => d.file ?? d.documentId ?? '')).size
    const ok = Math.max(0, totalDocuments - affected)

    const head =
      `${errs > 0 ? red('✖') : yellow('⚠')} contentmap — ` +
      `${count(errs, 'error')}, ${count(warns, 'warning')} ` +
      `in ${totalDocuments.toLocaleString()} document${totalDocuments === 1 ? '' : 's'} ` +
      dim(`(${ok.toLocaleString()} ok)`)

    const lines: string[] = [head, '']

    for (const [code, group] of byCode) {
      const label = TITLES[code] ?? code
      const worst: DiagnosticSeverity = group.some(d => d.severity === 'error') ? 'error' : 'warning'
      const tag = worst === 'error' ? '' : dim(', warn')
      lines.push(`  ${bold(label)} ${dim(`(${group.length}${tag})`)}`)

      const byFile = new Map<string, Diagnostic[]>()
      for (const d of group) {
        const key = d.file ?? d.documentId ?? '(unknown)'
        const list = byFile.get(key)
        if (list) list.push(d)
        else byFile.set(key, [d])
      }

      const files = [...byFile.entries()]
      files.forEach(([file, ds], i) => {
        const last = i === files.length - 1
        lines.push(`  ${last ? '└─' : '├─'} ${cyan(file)}`)
        const gutter = last ? '     ' : `  ${gray('│')}  `
        for (const d of ds) {
          const field = d.field ? bold(d.field.padEnd(12)) : ' '.repeat(12)
          lines.push(`${gutter}${field} ${d.message}`)
          if (d.hint) lines.push(`${gutter}${' '.repeat(12)} ${dim(d.hint)}`)
        }
      })
      lines.push('')
    }

    return lines.join('\n')
  }
}

const TITLES: Record<string, string> = {
  CM_VALIDATION: 'Validation',
  CM_PARSE: 'Parse',
  CM_READ: 'Read',
  CM_UNKNOWN_FIELD: 'Unknown field',
  CM_MISSING_REF: 'Missing reference',
  CM_CONFIG: 'Configuration',
  CM_NO_MATCH: 'No matching files'
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
