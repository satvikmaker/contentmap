import type { Diagnostic } from '../types.ts'

/**
 * Collects diagnostics, deduplicates them, and orders them deterministically.
 *
 * Ordering matters for snapshot tests and for humans: the same corpus must
 * always report in the same sequence, errors before warnings.
 */
export class DiagnosticBag {
  #items: Diagnostic[] = []
  #keys = new Set<string>()

  add(diagnostic: Diagnostic): void {
    // Only collapse genuinely identical diagnostics. Position is part of
    // identity: the same message at two different lines of one file is two
    // problems, not a repeat.
    const key = [
      diagnostic.code,
      diagnostic.file ?? '',
      diagnostic.documentId ?? '',
      diagnostic.field ?? '',
      diagnostic.line ?? '',
      diagnostic.column ?? '',
      diagnostic.message
    ].join(' ')
    if (this.#keys.has(key)) return
    this.#keys.add(key)
    this.#items.push(diagnostic)
  }

  get items(): readonly Diagnostic[] {
    return this.#items
  }

  get errors(): number {
    return this.#items.reduce((n, d) => (d.severity === 'error' ? n + 1 : n), 0)
  }

  get warnings(): number {
    return this.#items.reduce((n, d) => (d.severity === 'warning' ? n + 1 : n), 0)
  }

  get size(): number {
    return this.#items.length
  }

  clear(): void {
    this.#items = []
    this.#keys.clear()
  }

  /** Errors first, then by code, file and line, so output is reproducible. */
  sorted(): Diagnostic[] {
    const rank = { error: 0, warning: 1, info: 2 } as const
    return [...this.#items].sort(
      (a, b) =>
        rank[a.severity] - rank[b.severity] ||
        a.code.localeCompare(b.code) ||
        (a.file ?? '').localeCompare(b.file ?? '') ||
        (a.line ?? 0) - (b.line ?? 0) ||
        (a.field ?? '').localeCompare(b.field ?? '') ||
        a.message.localeCompare(b.message)
    )
  }
}
