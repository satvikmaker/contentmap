/**
 * Structured JSON for cached values.
 *
 * Plain JSON would silently turn a cached `Date` into a string on the next
 * build — a value that changes shape depending on whether the cache was warm is
 * the worst kind of bug to chase. This mirrors exactly what the serializer can
 * emit, so anything cacheable is also emittable.
 */

type Tagged = { $: string; v: unknown }

export function encode(value: unknown): unknown {
  if (value === undefined) return { $: 'undefined', v: 0 }
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? { $: 'bigint', v: value.toString() } : value
  }
  if (value instanceof Date) return { $: 'date', v: value.toISOString() }
  if (value instanceof RegExp) return { $: 'regexp', v: [value.source, value.flags] }
  if (value instanceof URL) return { $: 'url', v: value.href }
  if (value instanceof Map) {
    return { $: 'map', v: [...value.entries()].map(([k, v]) => [encode(k), encode(v)]) }
  }
  if (value instanceof Set) return { $: 'set', v: [...value].map(encode) }
  if (Array.isArray(value)) return value.map(encode)

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = encode(v)
  // A plain object whose own key is `$` would be mistaken for a tag on decode.
  return '$' in out ? { $: 'object', v: out } : out
}

export function decode(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(decode)

  const tagged = value as Partial<Tagged>
  if (typeof tagged.$ === 'string' && 'v' in tagged) {
    switch (tagged.$) {
      case 'undefined':
        return undefined
      case 'bigint':
        return BigInt(tagged.v as string)
      case 'date':
        return new Date(tagged.v as string)
      case 'regexp': {
        const [source, flags] = tagged.v as [string, string]
        return new RegExp(source, flags)
      }
      case 'url':
        return new URL(tagged.v as string)
      case 'map':
        return new Map((tagged.v as [unknown, unknown][]).map(([k, v]) => [decode(k), decode(v)]))
      case 'set':
        return new Set((tagged.v as unknown[]).map(decode))
      case 'object':
        return decode(tagged.v)
    }
  }

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = decode(v)
  return out
}
