import type { StandardSchemaV1 } from '@standard-schema/spec'

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

export interface Parser {
  name: string
  extensions: readonly string[]
  hasBody: boolean
  parse(input: { content: string; path: string }): Promisable<ParsedFile | ParsedFile[]>
}

export interface CollectionDefinition<TSchema extends StandardSchemaV1 = StandardSchemaV1> {
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
export type HasUnserializable<T, Depth extends readonly unknown[] = []> = Depth['length'] extends 6
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
