import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { InferSchema } from '../infer.ts'
import type {
  CollectionDefinition,
  HasUnserializable,
  InvalidType,
  NotSerializable,
  Parser,
  UserConfig
} from '../types.ts'

/**
 * Reject options that are not options.
 *
 * `T extends UserConfig` alone accepts any extra key, because T is inferred
 * from the argument and structurally still satisfies the constraint. So
 * `renderers: [markdown()]` compiled, was ignored, and surfaced later as "No
 * renderer configured" — a runtime error for something the compiler was
 * holding in its hand. It was wrong in three of our own READMEs for the same
 * reason. Mapping unknown keys to `never` turns a typo into an error at the
 * line that made it.
 */
type NoExtra<T, Shape> = T & { [K in Exclude<keyof T, keyof Shape>]: never }

/**
 * Identity functions. Zero runtime cost; they exist purely so TypeScript can
 * infer the collection's schema and transform types at the definition site.
 */
export function defineConfig<const T extends UserConfig>(config: NoExtra<T, UserConfig>): T {
  return config
}

/**
 * Declare a collection.
 *
 * The return type degrades to `InvalidType` when the schema produces something
 * we cannot write to disk, so the failure surfaces at the definition site with
 * a readable sentence rather than as a serializer crash mid-build.
 */
export function defineCollection<TSchema extends StandardSchemaV1, TOut = InferSchema<TSchema>>(
  collection: CollectionDefinition<TSchema, TOut>
): HasUnserializable<TOut> extends true
  ? InvalidType<NotSerializable, TOut>
  : CollectionDefinition<TSchema, TOut> {
  return collection as never
}

export function defineParser(parser: Parser): Parser {
  return parser
}
