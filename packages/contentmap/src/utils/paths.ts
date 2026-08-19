import { relative, sep } from 'node:path'

/** POSIX-normalised path. Windows separators are a portability trap. */
export function toPosix(p: string): string {
  return sep === '\\' ? p.replaceAll('\\', '/') : p
}

export function relPosix(from: string, to: string): string {
  return toPosix(relative(from, to))
}

/**
 * Document id from a path relative to the collection directory: extension
 * stripped, trailing `/index` removed. `posts/hello.md` -> `posts/hello`,
 * `posts/intro/index.md` -> `posts/intro`.
 */
export function idFromPath(relativePath: string): string {
  let id = toPosix(relativePath).replace(/\.[^./]+$/, '')
  if (id.endsWith('/index')) id = id.slice(0, -'/index'.length)
  else if (id === 'index') id = ''
  return id
}

/** Levenshtein distance, capped — powers did-you-mean hints. */
export function distance(a: string, b: string, max = 3): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost)
      row.push(v)
      if (v < best) best = v
    }
    if (best > max) return max + 1
    prev = row
  }
  return prev[b.length]!
}

/** Nearest candidate within edit distance 2, or undefined. */
export function suggest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined
  let bestScore = 3
  for (const c of candidates) {
    const d = distance(input, c, bestScore)
    if (d < bestScore) {
      bestScore = d
      best = c
    }
  }
  return best
}

/** Valid JS identifier — collection names become export names. */
export function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
}
