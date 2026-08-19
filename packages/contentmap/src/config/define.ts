import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { CollectionDefinition, Parser, UserConfig } from '../types.ts'

/**
 * Identity functions. Zero runtime cost; they exist purely so TypeScript can
 * infer the collection's schema and transform types at the definition site.
 */
export function defineConfig<const T extends UserConfig>(config: T): T {
  return config
}

export function defineCollection<TSchema extends StandardSchemaV1>(
  collection: CollectionDefinition<TSchema>
): CollectionDefinition<TSchema> {
  return collection
}

export function defineParser(parser: Parser): Parser {
  return parser
}
