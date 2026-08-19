import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { defineCollection } from '../src/config/define.ts'
import type { HasUnserializable, InvalidType, NotSerializable } from '../src/types.ts'

describe('serializability is enforced at compile time', () => {
  it('detects unemittable members', () => {
    expectTypeOf<HasUnserializable<{ a: string }>>().toEqualTypeOf<false>()
    expectTypeOf<HasUnserializable<{ a: Date; b: RegExp; c: URL }>>().toEqualTypeOf<false>()
    expectTypeOf<HasUnserializable<{ a: string[] }>>().toEqualTypeOf<false>()
    expectTypeOf<HasUnserializable<{ a: Map<string, number> }>>().toEqualTypeOf<false>()

    expectTypeOf<HasUnserializable<{ a: () => void }>>().toEqualTypeOf<true>()
    expectTypeOf<HasUnserializable<{ a: { b: () => void } }>>().toEqualTypeOf<true>()
    expectTypeOf<HasUnserializable<{ a: Array<() => void> }>>().toEqualTypeOf<true>()
    expectTypeOf<HasUnserializable<{ a: symbol }>>().toEqualTypeOf<true>()
  })

  it('accepts a schema whose output is serializable', () => {
    const posts = defineCollection({
      name: 'posts',
      directory: 'content',
      include: '**/*.md',
      schema: z.object({ title: z.string(), date: z.coerce.date(), tags: z.array(z.string()) })
    })
    expectTypeOf(posts).not.toEqualTypeOf<InvalidType<NotSerializable, unknown>>()
    expectTypeOf(posts.name).toEqualTypeOf<string>()
  })

  it('degrades to a readable error type when the output cannot be written', () => {
    const bad = defineCollection({
      name: 'bad',
      directory: 'content',
      include: '**/*.md',
      schema: z.object({ render: z.custom<() => string>() })
    })
    // tsc prints the embedded sentence and a docs link rather than a
    // structural mismatch the reader has to decode.
    expectTypeOf(bad).toEqualTypeOf<InvalidType<NotSerializable, { render: () => string }>>()
  })
})
