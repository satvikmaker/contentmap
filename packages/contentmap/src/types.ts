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
  documents: number
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
