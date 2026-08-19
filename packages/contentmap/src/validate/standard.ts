import type { StandardSchemaV1 } from '@standard-schema/spec'

export interface ValidationIssue {
  message: string
  path: string | undefined
}

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issues: ValidationIssue[] }

/**
 * Validate against any Standard Schema implementation — zod, valibot, arktype,
 * effect schema. Core depends on `@standard-schema/spec`, which ships zero
 * runtime bytes, and on no validator at all.
 *
 * `input` is `unknown` rather than `InferInput<T>`: the spec's own example uses
 * InferInput, which is wrong here because our input is arbitrary parsed YAML.
 */
export async function validate(
  schema: StandardSchemaV1,
  input: unknown
): Promise<ValidationResult> {
  // Sync fast path: arktype and valibot never return a promise, and awaiting
  // unconditionally would cost a microtask per document.
  let result = schema['~standard'].validate(input)
  if (result instanceof Promise) result = await result

  if (result.issues) {
    return { ok: false, issues: result.issues.map(toIssue) }
  }
  return { ok: true, value: result.value as Record<string, unknown> }
}

function toIssue(issue: StandardSchemaV1.Issue): ValidationIssue {
  return { message: issue.message, path: dotPath(issue.path) }
}

/**
 * Render an issue path as `nested.deep` / `list[0].a`.
 *
 * The spec allows a segment to be either a PropertyKey or a `{ key }` object.
 * content-collections interpolates the raw array, which yields `nested,deep`
 * and `[object Object]` for every valibot issue.
 */
export function dotPath(
  path: ReadonlyArray<PropertyKey | StandardSchemaV1.PathSegment> | undefined
): string | undefined {
  if (!path || path.length === 0) return undefined
  let out = ''
  for (const segment of path) {
    const key: PropertyKey =
      typeof segment === 'object' && segment !== null && 'key' in segment ? segment.key : segment
    if (typeof key === 'symbol') return undefined
    if (typeof key === 'number') out += `[${key}]`
    else if (out === '') out = String(key)
    else out += `.${String(key)}`
  }
  return out === '' ? undefined : out
}
