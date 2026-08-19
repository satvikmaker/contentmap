import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { CollectionDefinition, DocumentMeta, UserConfig } from './types.ts'

/**
 * Type-level plumbing for the generated `.d.ts`.
 *
 * The emitted declaration imports the user's own config and pulls types back
 * out through these helpers, so the generated types can never drift from the
 * config and inference flows through arbitrary schemas without us generating a
 * structural type tree.
 */
export type InferSchema<T> = T extends StandardSchemaV1<unknown, infer Out> ? Out : never

type Collections<C> = C extends UserConfig ? C['collections'] : never

/** The full document type for collection `K`, including `_meta`. */
export type InferDoc<C, K extends keyof Collections<C> & string> =
  Collections<C>[K] extends CollectionDefinition<infer S>
    ? InferSchema<S> extends infer Data
      ? Data extends Record<string, unknown>
        ? Data & { _meta: DocumentMeta }
        : never
      : never
    : never

type HeavyOf<C, K extends keyof Collections<C> & string> =
  Collections<C>[K] extends { heavy: readonly (infer H)[] }
    ? H & string
    : 'content' | 'html' | 'mdx' | 'body' | 'raw'

type IndexListOf<C, K extends keyof Collections<C> & string> =
  Collections<C>[K] extends { index: readonly (infer I)[] } ? I & string : never

/**
 * The index type.
 *
 * When a collection declares an explicit `index` list, only those fields are
 * carried — so the type must narrow to match, or it promises fields the runtime
 * dropped. Otherwise it is the document minus heavy fields.
 *
 * Identity lives in `_meta.id`, not a synthetic top-level `id` — a synthetic
 * field would shadow a user's own `id` (authors commonly declare one) and would
 * not be a member of the document type, breaking `Query<T, K extends keyof T>`.
 */
export type InferIndex<C, K extends keyof Collections<C> & string> = [
  IndexListOf<C, K>
] extends [never]
  ? Omit<InferDoc<C, K>, HeavyOf<C, K>>
  : Pick<InferDoc<C, K>, (IndexListOf<C, K> | '_meta') & keyof InferDoc<C, K>>
