import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Loader } from './loaders/types.ts'

type InferOutput<T extends StandardSchemaV1> = StandardSchemaV1.InferOutput<T>

export type Promisable<T> = T | Promise<T>

/** How a class of problem affects the build. */
export type Severity = 'fail' | 'warn' | 'skip' | 'ignore'

export type DiagnosticSeverity = 'error' | 'warning' | 'info'

export interface Diagnostic {
  code: string
  severity: DiagnosticSeverity
  message: string
  file?: string
  line?: number
  column?: number
  /** Dot-path into the document, e.g. `nested.deep` or `list[0].a`. */
  field?: string
  /** Actionable next step or did-you-mean. */
  hint?: string
  /** Rendered source excerpt with a caret. Human output only; never in --json. */
  frame?: string
  collection?: string
  documentId?: string
}

/** Identity and provenance of one document. */
export interface DocumentMeta {
  id: string
  filePath: string
  fileName: string
  directory: string
  extension: string
  /** URL-ish path: extension stripped, trailing `/index` removed. */
  path: string
  slug: string
  digest: string
}

export interface ParsedFile {
  data: Record<string, unknown>
  body?: string
}

export interface RenderInput {
  /** Document body, frontmatter already stripped. */
  body: string
  /** Absolute path, for renderers that resolve relative references. */
  path: string
  meta: DocumentMeta
}

export interface Heading {
  depth: number
  text: string
  id: string
}

/**
 * A markdown renderer.
 *
 * Core ships none. The measured spread between engines is 0.57ms and 58.8ms for
 * the same document, so hard-wiring one is the mistake velite made — it inlines
 * the whole unified graph at build time, leaving users unable to dedupe or
 * patch remark, and security scanners with nothing to see.
 *
 * `toPlain` and `headings` are optional: core derives both from the rendered
 * HTML when a renderer does not provide them, so a minimal renderer is a single
 * function.
 */
export interface Renderer {
  name: string
  toHtml(input: RenderInput, options?: unknown): Promisable<string>
  toPlain?(input: RenderInput): Promisable<string>
  headings?(input: RenderInput): Promisable<readonly Heading[]>
}

export interface ImageMeasurement {
  width: number
  height: number
  format: string
}

export interface ImagePlaceholder {
  /** Data URI, generated at build time so the client ships no decoder. */
  dataUri: string
  /** Average colour as #rrggbb. */
  color: string
  opaque: boolean
}

/**
 * Measures images and optionally produces a placeholder.
 *
 * Split from the renderer because the two have nothing to do with each other,
 * and split out of core because measuring costs a dependency most projects that
 * only ship prose do not need.
 */
export interface ImageProcessor {
  name: string
  measure(buffer: Uint8Array, path: string): Promisable<ImageMeasurement | undefined>
  placeholder?(buffer: Uint8Array, path: string): Promisable<ImagePlaceholder | undefined>
}

export interface Asset {
  /** Public URL. */
  src: string
  /** Bytes on disk. */
  size: number
}

export interface Image extends Asset {
  width: number
  height: number
  format: string
  aspectRatio: number
  /** Absent when no decoder is available (e.g. installed with --omit=optional). */
  placeholder?: string
  color?: string
}

export interface MarkdownRenderOptions {
  /**
   * Rewrite relative asset URLs in the output and copy what they point at.
   * Default true.
   */
  assets?: boolean
  /** Passed through to the renderer. */
  renderer?: unknown
}

export interface TocEntry {
  depth: number
  text: string
  id: string
  children: TocEntry[]
}

export interface ReadingTime {
  minutes: number
  words: number
  characters: number
}

export interface ExcerptOptions {
  /** Maximum characters. Default 260. */
  length?: number
  /** Explicit cut marker in the source. Default `<!--more-->`. */
  separator?: string | false
}

export interface TocOptions {
  /** Shallowest heading level included. Default 2. */
  minDepth?: number
  /** Deepest heading level included. Default 3. */
  maxDepth?: number
}

export interface ReadingTimeOptions {
  /** Words per minute. Default 265, the constant Gatsby popularised. */
  wpm?: number
}

/** Signals that a document should be dropped without being an error. */
export const SKIP: unique symbol = Symbol.for('contentmap.skip')
export interface SkipSignal {
  readonly [SKIP]: true
  readonly reason: string | undefined
}

/**
 * What a `transform` receives alongside the validated document.
 *
 * Derived values live here rather than in the schema because the schema belongs
 * to the user's validator. Velite put them in the schema and had to fork Zod to
 * do it — 5,754 lines and three years of unfixable type-leak bugs.
 */
export interface TransformContext {
  meta: DocumentMeta
  /** Raw body, frontmatter stripped. */
  body: string
  /** Rendered HTML, via the configured renderer. Memoised per document. */
  markdown(options?: MarkdownRenderOptions): Promise<string>
  /** Copy a file referenced relative to this document; returns its public URL. */
  asset(path: string): Promise<string>
  /** Copy an image and measure it. */
  image(path: string): Promise<Image>
  /** Body as plain text, markup removed. Memoised. */
  plain(): Promise<string>
  excerpt(options?: ExcerptOptions): Promise<string>
  toc(options?: TocOptions): Promise<TocEntry[]>
  readingTime(options?: ReadingTimeOptions): Promise<ReadingTime>
  /** Drop this document. Reported, not an error. */
  skip(reason?: string): never

  // — relations —
  /**
   * Every document in another collection, fully transformed.
   *
   * Always transformed. content-collections mutates its collection array inside
   * a sequential loop, so this returns transformed documents when the target
   * appears earlier in the config and untransformed ones when it appears later:
   * reordering an array silently changes your data (their issue #396, open
   * since Nov 2024). Here the target is built on demand, so order is irrelevant.
   */
  documents<C extends CollectionRef>(collection: C): Promise<DocumentOf<C>[]>
  /**
   * Every OTHER document in this collection, as validated by the schema.
   *
   * Pre-transform by construction: a transform cannot see its own collection's
   * transformed output without the collection depending on itself. This is what
   * "related posts" and "previous/next" need, and asking for the collection
   * itself through `documents()` is reported as a cycle.
   */
  siblings<T = AnyDocument>(): Promise<T[]>
  /** Embed one document. Missing ids fail the build, naming the file. */
  resolve<C extends CollectionRef>(collection: C, id: string): Promise<DocumentOf<C>>
  /** Embed several. Every missing id is reported, not just the first. */
  resolveMany<C extends CollectionRef>(
    collection: C,
    ids: readonly string[]
  ): Promise<DocumentOf<C>[]>
  /** Check an id exists and return it, without embedding the document. */
  reference(collection: CollectionRef, id: string): Promise<string>

  // — expensive work —
  /**
   * Run `fn` once and reuse the result until `input` or the config changes.
   *
   * Values round-trip through a structured codec, so a cached `Date` is still a
   * `Date` on a warm build.
   */
  cache<T>(input: unknown, fn: () => Promise<T> | T, options?: { key?: string }): Promise<T>

  // — escape hatches —
  /** Write a file into the output directory; returns its path. */
  emitFile(name: string, content: string | Uint8Array): Promise<string>
  /** Mark a file as a rebuild trigger for this document. */
  addWatchFile(path: string): void

  logger: Logger
}

/** A collection, referred to by its definition or its name. */
export type CollectionRef = CollectionDefinition<never, never> | { name: string } | string

/**
 * The document type a collection produces.
 *
 * Passing the definition itself — `ctx.resolve(authors, id)` — recovers the
 * author's real shape, including whatever its transform added. Referring to a
 * collection by name cannot be typed, so it degrades to `AnyDocument`.
 */
export type DocumentOf<C> =
  C extends CollectionDefinition<infer S, infer O>
    ? (unknown extends O ? InferOutput<S> : O) extends infer Data
      ? Data extends Record<string, unknown>
        ? Data & { _meta: DocumentMeta }
        : AnyDocument
      : AnyDocument
    : AnyDocument

export interface Logger {
  info(message: string): void
  warn(message: string): void
  debug(message: string): void
}

export interface Parser {
  name: string
  extensions: readonly string[]
  hasBody: boolean
  parse(input: { content: string; path: string }): Promisable<ParsedFile | ParsedFile[]>
}

export interface CollectionDefinition<
  TSchema extends StandardSchemaV1 = StandardSchemaV1,
  TOut = unknown
> {
  /**
   * Defaults to the key in `collections`.
   *
   * Required by the type until 0.2, while the resolver had always defaulted it
   * — so the docs omitted it, the compiler demanded it, and every config
   * repeated a name it had already written one line above.
   */
  name?: string
  /**
   * Where the documents come from.
   *
   * Supply a `loader` for anything that is not local files. `directory` and
   * `include` are then unused.
   */
  loader?: Loader
  directory?: string
  include?: string | readonly string[]
  exclude?: string | readonly string[]
  parser?: string | Parser
  schema: TSchema
  single?: boolean
  typeName?: string
  /** Fields carried in the eager index. Defaults to all non-heavy fields. */
  index?: readonly string[]
  /** Fields never carried in the index. Defaults to content/html/mdx/body/raw. */
  heavy?: readonly string[]
  /**
   * Derive fields the schema cannot: rendered HTML, reading time, excerpts.
   * The return value becomes the document type.
   */
  /**
   * Method syntax, deliberately.
   *
   * As a property with a function type this parameter is contravariant under
   * `strictFunctionTypes`, so a concrete collection stops being assignable to
   * the erased `CollectionDefinition` that `UserConfig.collections` holds —
   * and every user with a transform gets a type error inside their own config
   * file. `next build` type-checks the project, so it failed the build
   * outright. Method syntax is bivariant, which is what the container needs;
   * `defineCollection` still infers `doc` from the schema at the call site,
   * so nothing is lost where the type actually matters.
   */
  transform?(doc: InferOutput<TSchema>, ctx: TransformContext): TOut | Promise<TOut>
  /**
   * Applied after the default id sort, before emission.
   *
   * content-collections refuses to provide this (issue #169, closed as
   * documentation), so every consumer re-sorts at runtime. Sorting once at
   * build time is free and removes universal boilerplate.
   */
  sort?: (a: AnyDocument, b: AnyDocument) => number
  format?: EmitFormat
}

/** A document as a `sort` comparator sees it: schema output plus `_meta`. */
export type AnyDocument = Record<string, unknown> & { _meta: DocumentMeta }

/**
 * Compile-time rejection carrying a human-readable sentence.
 *
 * Embedding the explanation in the type means `tsc` prints actual guidance and
 * a docs link, instead of a structural mismatch the reader has to decode. The
 * technique is content-collections'; it is the one piece of their type layer
 * worth copying wholesale.
 */
export declare const invalid: unique symbol
export interface InvalidType<Message extends string, T> {
  readonly [invalid]: Message
  readonly received: T
}

export type NotSerializable =
  'Documents are written to disk as JavaScript, so every field must be serializable. Functions and symbols cannot be emitted. See https://contentmap.dev/docs/serialization'

/**
 * True when `T` contains a function or symbol anywhere.
 *
 * Deliberately shallow in what it special-cases: Date/RegExp/URL/Map/Set all
 * round-trip through our serializer, so only the genuinely unemittable types
 * are rejected. Recursion is bounded by `Depth` to keep tsc cheap.
 */
type IsAny<T> = 0 extends 1 & T ? true : false

export type HasUnserializable<T, Depth extends readonly unknown[] = []> = Depth['length'] extends 6
  ? false
  : // `any` satisfies BOTH branches of every conditional, so it resolves to
    // `boolean` and `true extends boolean` reports a false positive — a schema
    // using z.any() would be rejected as unemittable.
    IsAny<T> extends true
    ? false
    : T extends (...args: never[]) => unknown
      ? true
      : T extends symbol
        ? true
        : T extends Date | RegExp | URL | string | number | boolean | bigint | null | undefined
          ? false
          : T extends readonly (infer U)[]
            ? HasUnserializable<U, [...Depth, 0]>
            : T extends Map<infer K, infer V>
              ? HasUnserializable<K | V, [...Depth, 0]>
              : T extends Set<infer U>
                ? HasUnserializable<U, [...Depth, 0]>
                : T extends object
                  ? true extends {
                      [K in keyof T]-?: HasUnserializable<T[K], [...Depth, 0]>
                    }[keyof T]
                    ? true
                    : false
                  : false

export type EmitFormat = 'modules' | 'bundle' | 'both'

export interface OutputOptions {
  dir?: string
  /** Incremental cache location. Defaults to `<dir>/.cache`. */
  cacheDir?: string
  assets?: string
  assetsBase?: string
  assetsName?: string
  format?: EmitFormat
  types?: 'trampoline' | 'explicit' | false
  clean?: boolean
}

/**
 * A collection after resolution, with every default filled in.
 *
 * `name` is optional on the way in and guaranteed on the way out, so the
 * builder never has to re-derive it and a user never has to repeat the key
 * they just wrote.
 */
export type ResolvedCollection = CollectionDefinition & { name: string }

export interface UserConfig {
  collections: Record<string, CollectionDefinition>
  root?: string
  output?: OutputOptions
  parsers?: readonly Parser[]
  /** Markdown renderer. Without one, `ctx.markdown()` is a build error. */
  renderer?: Renderer
  /** Image measurement. Without one, `ctx.image()` is a build error. */
  images?: ImageProcessor
  /** Extensions treated as copyable assets. Defaults to a broad allowlist. */
  assetExtensions?: readonly string[]
  concurrency?: number
  /** Parallel file reads. Defaults to 64, the measured optimum. */
  readConcurrency?: number
  onValidationError?: Severity
  onUnknownField?: Severity
}

export interface ResolvedOutput {
  dir: string
  /**
   * Where incremental caches live. Defaults to `<dir>/.cache`.
   *
   * Relocatable because CI mounts a cache volume, and because a bundler that
   * cleans its own output directory should not be able to take the cache with
   * it.
   */
  cacheDir: string
  assets: string
  assetsBase: string
  assetsName: string
  format: EmitFormat
  types: 'trampoline' | 'explicit' | false
  clean: boolean
}

export interface ResolvedConfig {
  dryRun: boolean
  frozen: boolean
  root: string
  configPath: string
  /** Files whose change should reload the config. */
  configDeps: readonly string[]
  /** sha256 over the config source and its local imports. Namespaces the cache. */
  configDigest: string
  collections: Record<string, ResolvedCollection>
  output: ResolvedOutput
  parsers: readonly Parser[]
  renderer: Renderer | undefined
  images: ImageProcessor | undefined
  assetExtensions: readonly string[]
  concurrency: number
  readConcurrency: number
  onValidationError: Severity
  onUnknownField: Severity
}

/** One document as it exists after parse + validate. */
export interface StoreEntry {
  id: string
  collection: string
  digest: string
  data: Record<string, unknown>
  meta: DocumentMeta
  mtimeMs: number
  /** Byte length, paired with mtimeMs so a same-millisecond rewrite is seen. */
  size: number
  /** Emitted asset filenames this document owns. */
  assets?: readonly string[]
  /** Files this document referenced, so a changed asset invalidates it. */
  assetDeps?: readonly { path: string; digest: string; mtimeMs: number; size: number }[]
  /** Documents this one referenced, so editing a target invalidates it. */
  refDeps?: readonly { collection: string; id: string; digest: string }[]
  /**
   * External files a transform declared, with their digests.
   *
   * Tracked exactly like asset dependencies: they take part in `emitKey`, so a
   * change to one produces different output and is actually written. Recording
   * only the paths would re-run the transform and then skip the write, because
   * the source document itself is untouched.
   */
  watchDeps?: readonly { path: string; digest: string; mtimeMs: number; size: number }[]
  /**
   * Digest of everything the emitted output depends on.
   *
   * NOT the same as `digest`, which covers only the source file. A document
   * whose image changed produces different output from an identical source, so
   * skipping the write on the source digest alone leaves the page pointing at a
   * fingerprint that no longer exists on disk.
   */
  emitKey: string
}

export interface BuildResult {
  collections: number
  /** Documents emitted. */
  documents: number
  /** Documents considered, including those dropped by errors. */
  scanned: number
  errors: number
  warnings: number
  durationMs: number
  cacheHits: number
  diagnostics: readonly Diagnostic[]
  /**
   * Wall-clock milliseconds per phase, for `--verbose`.
   *
   * Cumulative across concurrent work rather than a partition of `durationMs`:
   * sixty-four files parse at once, so these overlap each other and overshoot
   * the total. They answer "which phase dominates", not "where did the
   * wall-clock go".
   */
  phases: Readonly<Record<string, number>>
}

export interface BuilderOptions {
  config?: string
  /** Incremental cache location. Defaults to `<outDir>/.cache`. */
  cacheDir?: string
  /** Refuse network access; remote collections must be satisfied from cache. */
  frozen?: boolean
  root?: string
  outDir?: string
  concurrency?: number
  format?: EmitFormat
  clean?: boolean
  onValidationError?: Severity
  /** Validate only — collect, parse and check, but write nothing. Powers `check`. */
  dryRun?: boolean
}

export interface BuildOptions {
  /** Paths the watcher saw change, relative to each collection. */
  changed?: ReadonlySet<string>
  /** Collections to refetch regardless of their revalidate window. */
  forceLoaders?: ReadonlySet<string>
  /** Payload forwarded to loaders as `refreshContext`. */
  refreshContext?: Record<string, unknown>
}

export interface RefreshOptions {
  /** Limit the refresh to these collections. Default: all. */
  loaders?: readonly string[]
  /** Reaches the loader as `refreshContext`. */
  context?: Record<string, unknown>
}

export type BuilderEvent =
  | { type: 'build:start' }
  | { type: 'build:end'; result: BuildResult }
  | { type: 'diagnostic'; diagnostic: Diagnostic }
  | { type: 'config:loaded'; path: string }
  | { type: 'watch:change'; path: string }
  | { type: 'log'; level: 'info' | 'warn' | 'debug'; message: string }
