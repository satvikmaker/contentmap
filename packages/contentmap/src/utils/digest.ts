import { createHash } from 'node:crypto'

/**
 * Content digest. Non-cryptographic use — this keys the incremental cache.
 *
 * sha1 via node:crypto measured 5.6ms for 10,000 buffers, i.e. free next to the
 * ~516ms those same reads cost. That makes an extra wasm-hash dependency
 * unjustifiable, so we deviate from the spec's nominal xxhash64 here.
 */
export function digest(input: string | Uint8Array): string {
  return createHash('sha1').update(input).digest('hex')
}

/** Cache-key hash. Distinct from `digest` so the two can diverge later. */
export function cacheKey(...parts: readonly string[]): string {
  const h = createHash('sha256')
  for (const p of parts) h.update(p).update('\0')
  return h.digest('hex')
}

/**
 * Deterministic JSON. Plain-object keys are sorted so structurally equal inputs
 * always produce the same cache key regardless of insertion order —
 * content-collections uses raw `JSON.stringify` and takes spurious misses.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) return val
    const proto: unknown = Object.getPrototypeOf(val)
    if (proto !== Object.prototype && proto !== null) return val
    const source = val as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(source).sort()) sorted[k] = source[k]
    return sorted
  })
}
