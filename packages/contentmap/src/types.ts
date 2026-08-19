import type { StandardSchemaV1 } from '@standard-schema/spec'

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
  markdown(options?: unknown): Promise<string>
  /** Body as plain text, markup removed. Memoised. */
  plain(): Promise<string>
  excerpt(options?: ExcerptOptions): Promise<string>
  toc(options?: TocOptions): Promise<TocEntry[]>
  readingTime(options?: ReadingTimeOptions): Promise<ReadingTime>
  /** Drop this document. Reported, not an error. */
  skip(reason?: string): never
  logger: Logger
}

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
  name: string
  directory: string
  include: string | readonly string[]
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
  transform?: (doc: InferOutput<TSchema>, ctx: TransformContext) => TOut | Promise<TOut>
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
  assets?: string
  assetsBase?: string
  assetsName?: string
  format?: EmitFormat
  types?: 'trampoline' | 'explicit' | false
  clean?: boolean
}

export interface UserConfig {
  collections: Record<string, CollectionDefinition>
  root?: string
  output?: OutputOptions
  parsers?: readonly Parser[]
  /** Markdown renderer. Without one, `ctx.markdown()` is a build error. */
  renderer?: Renderer
  concurrency?: number
  /** Parallel file reads. Defaults to 64, the measured optimum. */
  readConcurrency?: number
  onValidationError?: Severity
  onUnknownField?: Severity
}

export interface ResolvedOutput {
  dir: string
  assets: string
  assetsBase: string
  assetsName: string
  format: EmitFormat
  types: 'trampoline' | 'explicit' | false
  clean: boolean
}

export interface ResolvedConfig {
  dryRun: boolean
  root: string
  configPath: string
  /** Files whose change should reload the config. */
  configDeps: readonly string[]
  /** sha256 over the config source and its local imports. Namespaces the cache. */
  configDigest: string
  collections: Record<string, CollectionDefinition>
  output: ResolvedOutput
  parsers: readonly Parser[]
  renderer: Renderer | undefined
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
}

export interface BuilderOptions {
  config?: string
  root?: string
  outDir?: string
  concurrency?: number
  format?: EmitFormat
  clean?: boolean
  onValidationError?: Severity
  /** Validate only — collect, parse and check, but write nothing. Powers `check`. */
  dryRun?: boolean
}

export type BuilderEvent =
  | { type: 'build:start' }
  | { type: 'build:end'; result: BuildResult }
  | { type: 'diagnostic'; diagnostic: Diagnostic }
  | { type: 'config:loaded'; path: string }
  | { type: 'watch:change'; path: string }
  | { type: 'log'; level: 'info' | 'warn' | 'debug'; message: string }
