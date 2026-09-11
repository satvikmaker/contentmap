import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { defineCollection, defineConfig } from '../src/config/define.ts'
import type { AnyDocument, DocumentMeta, DocumentOf } from '../src/types.ts'
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

    // `any` satisfies both branches of every conditional, so an unguarded
    // check resolves to `boolean` and rejects z.any() as unemittable.
    expectTypeOf<HasUnserializable<{ a: any }>>().toEqualTypeOf<false>()
    expectTypeOf<HasUnserializable<{ a: unknown }>>().toEqualTypeOf<false>()
    expectTypeOf<HasUnserializable<Record<string, unknown>>>().toEqualTypeOf<false>()
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

describe('afterBuild', () => {
  const posts = defineCollection({
    name: 'posts',
    directory: 'content',
    include: '**/*.md',
    schema: z.object({ title: z.string(), date: z.coerce.date() })
  })

  it('types documents by the definition passed in', () => {
    defineConfig({
      collections: { posts },
      afterBuild: ctx => {
        const [first] = ctx.documents(posts)
        expectTypeOf(first!.title).toEqualTypeOf<string>()
        expectTypeOf(first!.date).toEqualTypeOf<Date>()
        expectTypeOf(first!._meta).toEqualTypeOf<DocumentMeta>()
        // A name cannot carry a type, so it degrades to a loose document.
        expectTypeOf(ctx.documents('posts')).toEqualTypeOf<AnyDocument[]>()
        expectTypeOf(ctx.writeFile).returns.resolves.toEqualTypeOf<string>()
      }
    })
  })

  it('takes several hooks, sync or async', () => {
    defineConfig({ collections: { posts }, afterBuild: [() => {}, async () => {}] })
  })

  it('takes a hook that returns something, as a concise arrow does', () => {
    // `ctx => ctx.writeFile(…)` returns Promise<string>. A return type of
    // Promisable<void> rejected it, and `next build` failed on the example.
    defineConfig({ collections: { posts }, afterBuild: ctx => ctx.writeFile('search.json', '[]') })
  })
})

describe('reference inference', () => {
  const authors = defineCollection({
    name: 'authors',
    directory: 'content/authors',
    include: '**/*.yaml',
    schema: z.object({ id: z.string(), name: z.string() }),
    transform: d => ({ ...d, initials: d.name.slice(0, 1) })
  })

  it('recovers the target document type, including transform output', () => {
    expectTypeOf<DocumentOf<typeof authors>>().toExtend<{
      id: string
      name: string
      initials: string
      _meta: DocumentMeta
    }>()
  })

  it('falls back to a loose document when a collection is named as a string', () => {
    expectTypeOf<DocumentOf<'authors'>>().toEqualTypeOf<AnyDocument>()
  })

  it('accepts a definition with a transform wherever a collection is expected', () => {
    // It was typed CollectionDefinition<never, never>, which a transformed
    // definition is not assignable to. The test above only ever looked at
    // DocumentOf directly, so the call itself went untested until a real
    // `next build` of an example refused to compile.
    defineCollection({
      name: 'posts',
      directory: 'content/posts',
      include: '**/*.md',
      schema: z.object({ author: z.string() }),
      transform: async (doc, ctx) => {
        const author = await ctx.resolve(authors, doc.author)
        expectTypeOf(author.initials).toEqualTypeOf<string>()
        const all = await ctx.documents(authors)
        expectTypeOf(all[0]!.initials).toEqualTypeOf<string>()
        return doc
      }
    })
    defineConfig({
      collections: { authors },
      afterBuild: ctx => {
        expectTypeOf(ctx.documents(authors)[0]!.initials).toEqualTypeOf<string>()
      }
    })
  })
})

describe('a user-shaped config compiles', () => {
  it('accepts a collection with a transform', () => {
    // `transform` as a property with a function type is contravariant under
    // strictFunctionTypes, so a concrete collection stopped being assignable to
    // the erased CollectionDefinition that UserConfig.collections holds. Every
    // user with a transform got a type error inside their own config file, and
    // `next build` type-checks the project, so it failed the build outright.
    //
    // This asserts the intent, but it is NOT the gate: these tests import
    // `../src`, and the bug only appears through the emitted `.d.ts`. Reverting
    // the fix leaves this test green. `pnpm verify:types` is what catches it,
    // by type-checking a user-shaped project against the built package.
    const posts = defineCollection({
      name: 'posts',
      directory: 'content/posts',
      include: '**/*.md',
      schema: z.object({ title: z.string(), date: z.coerce.date(), content: z.string() }),
      transform: (doc, ctx) => ({ ...doc, slug: ctx.meta.slug })
    })

    const config = defineConfig({ collections: { posts } })

    expectTypeOf(config.collections.posts).toMatchObjectType<{ name: string }>()
  })
})

describe('projection and index keys are separate', () => {
  it('allows sorting and filtering on fields that were not selected', () => {
    type Post = {
      _meta: DocumentMeta
      title: string
      date: Date
      slug: string
      content: string
    }
    type Index = Omit<Post, 'content'>

    const posts = {} as import('../src/runtime/index.ts').Query<Post, keyof Index>

    // The whole point: select what you render, sort by something else.
    expectTypeOf(posts.select('title', 'slug').sortBy('date', 'desc').all()).toEqualTypeOf<
      Pick<Post, 'title' | 'slug'>[]
    >()
    expectTypeOf(posts.select('title').where({ date: new Date() }).all()).toEqualTypeOf<
      Pick<Post, 'title'>[]
    >()
    expectTypeOf(posts.select('title').groupBy('slug')).toEqualTypeOf<
      Map<string, Pick<Post, 'title'>[]>
    >()
  })
})
