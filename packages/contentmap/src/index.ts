export { defineCollection, defineConfig, defineParser } from './config/define.ts'
export { defineLoader, http, RemoteFetchError, RemoteStore } from './loaders/index.ts'
export { findSecret, redactSecrets, screenForSecrets, SecretLeakError } from './security/secrets.ts'
// `collectionNameOf` is exported for packages that build on `afterBuild`:
// the hook context takes a CollectionRef, so anything wrapping it needs to
// resolve one to a name the same way the builder does — including a
// definition that never set a `name` of its own.
export { collectionNameOf, ConfigError, findConfig, resolveConfig } from './config/resolve.ts'
export { Builder, createBuilder } from './builder.ts'
export { BuildFailedError, formatDiagnostics } from './integration.ts'
export { startWatch } from './watch/index.ts'
export type { WatchHandle, WatchHooks, WatchOptions } from './watch/index.ts'
export { run } from './cli/run.ts'
export { init } from './cli/init.ts'
export type { InitOptions, InitResult } from './cli/init.ts'
export {
  codeFrame,
  DiagnosticBag,
  findKeyPosition,
  normalizeParserError,
  renderDiagnostics
} from './diagnostics/index.ts'
export type { Position, RenderOptions } from './diagnostics/index.ts'
export {
  builtinParsers,
  frontmatterOnlyParser,
  frontmatterParser,
  jsonParser,
  jsoncParser,
  rawParser,
  resolveParser,
  tomlParser,
  yamlParser
} from './parsers/index.ts'
export { parseFrontmatterBlock, splitFrontmatter } from './parsers/frontmatter.ts'
export { dotPath, validate } from './validate/standard.ts'
export { serialize, SerializeError } from './write/serialize.ts'
export { mapLimit } from './utils/limit.ts'
export { cacheKey, digest, stableStringify } from './utils/digest.ts'

export {
  buildToc,
  createTransformContext,
  excerptOf,
  htmlToHeadings,
  htmlToPlain,
  MissingRendererError,
  readingTimeOf,
  slugify
} from './render/index.ts'
export { SKIP } from './types.ts'
export {
  AssetStore,
  DEFAULT_ASSET_EXTENSIONS,
  expandTemplate,
  isImageExtension,
  isRelativeUrl,
  joinUrl,
  rewriteHtml,
  splitUrl
} from './assets/index.ts'
export { MissingImageProcessorError, MissingMdxCompilerError } from './render/context.ts'

export type { AnyDocument } from './types.ts'
export type { InferDoc, InferIndex, InferSchema } from './infer.ts'
export type { HasUnserializable, InvalidType, NotSerializable } from './types.ts'
export type { ModuleLoader, Query } from './runtime/index.ts'
export type {
  HttpLoaderOptions,
  LoadedRecord,
  Loader,
  LoaderContext,
  LoadResult,
  MetaStore,
  RemoteErrorPolicy,
  Revalidate
} from './loaders/index.ts'
export type {
  AfterBuildContext,
  AfterBuildHook,
  BuildOptions,
  RefreshOptions,
  Asset,
  Image,
  ImageMeasurement,
  ImagePlaceholder,
  ImageProcessor,
  MdxCompiler,
  MarkdownRenderOptions,
  ExcerptOptions,
  Heading,
  Logger,
  ReadingTime,
  ReadingTimeOptions,
  RenderInput,
  Renderer,
  SkipSignal,
  TocEntry,
  TocOptions,
  TransformContext,
  BuilderEvent,
  BuilderOptions,
  BuildResult,
  CollectionDefinition,
  // Named by AfterBuildContext.documents() and ctx.documents(), so a package
  // built on either has to be able to spell them.
  CollectionRef,
  DocumentOf,
  Diagnostic,
  DiagnosticSeverity,
  DocumentMeta,
  EmitFormat,
  OutputOptions,
  ParsedFile,
  Parser,
  Promisable,
  ResolvedConfig,
  ResolvedOutput,
  Severity,
  StoreEntry,
  UserConfig
} from './types.ts'
