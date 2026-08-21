import { digest } from '../utils/digest.ts'
/**
 * Serialize a value to evaluable JavaScript.
 *
 * JSON is lossy for content: a `z.coerce.date()` field round-trips to a string
 * and every consumer has to revive it. Emitting JS instead means `Date`, `Map`,
 * `Set`, `BigInt`, `RegExp` and `undefined` survive with no revival step —
 * the one thing content-collections gets unambiguously right.
 */
export class SerializeError extends Error {
  override readonly name = 'SerializeError'
  readonly path: string
  constructor(message: string, path: string) {
    super(message)
    this.path = path
  }
}

export function serialize(value: unknown, indent = 2): string {
  return write(value, indent, 0, new Set(), '$')
}

/**
 * Serialize as if nested at `depth`, so a caller can cache each element of a
 * large array and splice the fragments together. Rebuilding a 10,000-row index
 * from cached fragments is what keeps an incremental build proportional to the
 * change rather than to corpus size.
 */
export function serializeAt(value: unknown, depth: number, indent = 2): string {
  return write(value, indent, depth, new Set(), '$')
}

function write(
  value: unknown,
  indent: number,
  depth: number,
  seen: Set<object>,
  path: string
): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
      return Number.isFinite(value) ? String(value) : `Number(${JSON.stringify(String(value))})`
    case 'boolean':
      return String(value)
    case 'bigint':
      return `${value}n`
    case 'function':
      throw new SerializeError('Functions cannot be serialized into content output', path)
    case 'symbol':
      throw new SerializeError('Symbols cannot be serialized into content output', path)
  }

  const obj = value as object
  if (seen.has(obj)) throw new SerializeError('Circular reference in content output', path)
  seen.add(obj)
  try {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime())
        ? 'new Date(NaN)'
        : `new Date(${JSON.stringify(value.toISOString())})`
    }
    if (value instanceof RegExp) return String(value)
    if (value instanceof URL) return `new URL(${JSON.stringify(value.href)})`

    const pad = ' '.repeat(indent * (depth + 1))
    const close = ' '.repeat(indent * depth)

    if (Array.isArray(value)) {
      if (value.length === 0) return '[]'
      const items = value.map((v, i) => pad + write(v, indent, depth + 1, seen, `${path}[${i}]`))
      return `[\n${items.join(',\n')}\n${close}]`
    }
    if (value instanceof Map) {
      if (value.size === 0) return 'new Map()'
      const entries = [...value.entries()].map(
        ([k, v], i) =>
          `${pad}[${write(k, indent, depth + 1, seen, `${path}.key(${i})`)}, ` +
          `${write(v, indent, depth + 1, seen, `${path}.value(${i})`)}]`
      )
      return `new Map([\n${entries.join(',\n')}\n${close}])`
    }
    if (value instanceof Set) {
      if (value.size === 0) return 'new Set()'
      const items = [...value].map(
        (v, i) => pad + write(v, indent, depth + 1, seen, `${path}[${i}]`)
      )
      return `new Set([\n${items.join(',\n')}\n${close}])`
    }

    const proto: unknown = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new SerializeError(
        `Class instances cannot be serialized (got ${(obj.constructor as { name?: string })?.name ?? 'unknown'}). Return a plain object.`,
        path
      )
    }

    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length === 0) return '{}'
    const props = keys.map(k => {
      const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k)
      return `${pad}${key}: ${write(record[k], indent, depth + 1, seen, `${path}.${k}`)}`
    })
    return `{\n${props.join(',\n')}\n${close}}`
  } finally {
    seen.delete(obj)
  }
}

/**
 * Safe module-name fragment for a document id. `a/b` -> `a__b`.
 *
 * Sanitising alone is lossy, and lossy means collisions: `a b` and `a+b` both
 * became `a__b`, as did every pair of non-latin filenames, since the whole name
 * collapses to `__`. Two documents then raced to write one path and the build
 * died on a rename with an ENOENT naming a temp file — for filenames as ordinary
 * as a space and a plus.
 *
 * A short digest of the full id is appended whenever sanitising changed
 * anything, so ids that were already safe keep their readable filename and
 * everything else is unique and stable.
 */
export function moduleNameFor(id: string): string {
  // `/` is the one lossy replacement worth making silently: nested documents
  // are universal, and suffixing them all would rename every file in the output
  // directory to guard against a case nobody has hit.
  const flattened = id.replaceAll('/', '__')
  const safe = flattened.replace(/[^A-Za-z0-9._-]+/g, '__')
  const prefixed = /^[0-9]/.test(safe) ? `_${safe}` : safe || '_index'
  if (safe === flattened) return prefixed
  return `${prefixed}-${digest(id).slice(0, 8)}`
}
