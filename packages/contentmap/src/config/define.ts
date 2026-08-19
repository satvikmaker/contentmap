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
 * Identity functions. Zero runtime cost; they exist purely so TypeScript can
 * infer the collection's schema and transform types at the definition site.
 */
export function defineConfig<const T extends UserConfig>(config: T): T {
  return config
}

/**
 * Declare a collection.
 *
 * The return type degrades to `InvalidType` when the schema produces something
 * we cannot write to disk, so the failure surfaces at the definition site with
 * a readable sentence rather than as a serializer crash mid-build.
 */
export function defineCollection<TSchema extends StandardSchemaV1>(
  collection: CollectionDefinition<TSchema>
): HasUnserializable<InferSchema<TSchema>> extends true
  ? InvalidType<NotSerializable, InferSchema<TSchema>>
  : CollectionDefinition<TSchema> {
  return collection as never
}

export function defineParser(parser: Parser): Parser {
  return parser
}
