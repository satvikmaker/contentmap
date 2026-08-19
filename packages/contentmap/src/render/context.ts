import type {
  AnyDocument,
  CollectionRef,
  DocumentMeta,
  ExcerptOptions,
  Image,
  MarkdownRenderOptions,
  Heading,
  Logger,
  ReadingTime,
  ReadingTimeOptions,
  Renderer,
  SkipSignal,
  TocEntry,
  TocOptions,
  TransformContext
} from '../types.ts'
import { SKIP } from '../types.ts'
import {
  buildToc,
  DEFAULT_EXCERPT_SEPARATOR,
  excerptOf,
  htmlToHeadings,
  htmlToPlain,
  readingTimeOf
} from './derive.ts'

export class MissingRendererError extends Error {
  override readonly name = 'MissingRendererError'
  readonly hint: string
  constructor(what: string) {
    super(`No renderer configured, but ${what} was called`)
    this.hint =
      'Install a renderer and set it in your config: `import markdown from "@contentmap/markdown"` then `renderer: markdown()`.'
  }
}

export class MissingImageProcessorError extends Error {
  override readonly name = 'MissingImageProcessorError'
  readonly hint =
    'Install @contentmap/image and set it in your config: `import { image } from "@contentmap/image"` then `images: image()`.'
  constructor() {
    super('No image processor configured, but ctx.image() was called')
  }
}

/** Resolves and registers one asset referenced relative to a document. */
export type AssetResolver = (
  url: string
) => Promise<{ src: string; sourcePath: string; size: number } | undefined>

/** Measures an already-registered asset. */
export type ImageResolver = (
  url: string
) => Promise<Image | undefined>

/** Everything the builder supplies for relations, caching and file emission. */
export interface ContextServices {
  documents(collection: CollectionRef): Promise<AnyDocument[]>
  siblings(): Promise<AnyDocument[]>
  resolve(collection: CollectionRef, id: string): Promise<AnyDocument>
  resolveMany(collection: CollectionRef, ids: readonly string[]): Promise<AnyDocument[]>
  reference(collection: CollectionRef, id: string): Promise<string>
  cache<T>(input: unknown, fn: () => Promise<T> | T, options?: { key?: string }): Promise<T>
  emitFile(name: string, content: string | Uint8Array): Promise<string>
  addWatchFile(path: string): void
}

export interface ContextInput {
  meta: DocumentMeta
  body: string
  path: string
  renderer: Renderer | undefined
  logger: Logger
  services?: ContextServices
  /** Copies a relative reference. Undefined disables asset handling entirely. */
  resolveAsset?: AssetResolver
  resolveImage?: ImageResolver
  /** Rewrites relative URLs in rendered HTML. */
  rewrite?: (html: string) => Promise<string>
}

/**
 * Per-document transform context.
 *
 * Every derivation is memoised for the life of the document, so `excerpt()`,
 * `toc()` and `readingTime()` share a single render and a single plain-text
 * pass no matter how many of them a transform calls. Velite reaches the same
 * result with lazy getters on its file object; scoping the cache to the
 * document rather than a module-level map is what keeps concurrent builds from
 * leaking into each other.
 */
export function createTransformContext(input: ContextInput): TransformContext {
  const { meta, body, path, renderer, logger } = input

  const services = (): ContextServices => {
    if (!input.services) {
      throw new Error('contentmap: transform services are unavailable outside a build')
    }
    return input.services
  }
  const renderInput = { body, path, meta }

  // Two memos over ONE render. `rawPromise` is the renderer's output;
  // `htmlPromise` is that same output with asset URLs rewritten. Derivations
  // take the raw form — plain text holds no URLs, so rewriting during them
  // would copy files for a document that never emits their links — while
  // `markdown()` takes the rewritten one. Memoising only the rewritten form
  // made every derivation re-render.
  let rawPromise: Promise<string> | undefined
  let htmlPromise: Promise<string> | undefined
  let plainPromise: Promise<string> | undefined
  let headingsPromise: Promise<readonly Heading[]> | undefined

  const renderRaw = (rendererOptions?: unknown): Promise<string> => {
    if (!renderer) return Promise.reject(new MissingRendererError('ctx.markdown()'))
    return Promise.resolve(renderer.toHtml(renderInput, rendererOptions))
  }

  /** Renderer output, unrewritten. Memoised. */
  const raw = (): Promise<string> => {
    rawPromise ??= renderRaw()
    return rawPromise
  }

  const markdown = (options?: MarkdownRenderOptions): Promise<string> => {
    // Options bypass the cache: a caller asking for different output should get
    // it rather than whatever the first call happened to request.
    if (options !== undefined) {
      const withAssets = options.assets ?? true
      return renderRaw(options.renderer).then(html =>
        withAssets && input.rewrite ? input.rewrite(html) : html
      )
    }
    htmlPromise ??= raw().then(html => (input.rewrite ? input.rewrite(html) : html))
    return htmlPromise
  }

  const plain = (): Promise<string> => {
    plainPromise ??= (async () => {
      if (renderer?.toPlain) return await renderer.toPlain(renderInput)
      if (renderer) return htmlToPlain(await raw())
      // Without a renderer, fall back to the raw body. Reading time and
      // excerpts stay useful for plain-text sources rather than hard-failing.
      return htmlToPlain(body)
    })()
    return plainPromise
  }

  const headings = (): Promise<readonly Heading[]> => {
    headingsPromise ??= (async () => {
      if (renderer?.headings) return await renderer.headings(renderInput)
      if (!renderer) throw new MissingRendererError('ctx.toc()')
      return htmlToHeadings(await raw())
    })()
    return headingsPromise
  }

  return {
    meta,
    body,
    logger,
    markdown,
    plain,
    async excerpt(options: ExcerptOptions = {}): Promise<string> {
      const separator = options.separator ?? DEFAULT_EXCERPT_SEPARATOR
      if (separator !== false && separator !== '') {
        const cut = body.indexOf(separator)
        if (cut !== -1) {
          // Render only the prefix, so the marker path returns prose rather
          // than the raw markdown that stripping tags off a source string
          // leaves behind (`**bold**`, backticks and all).
          const prefix = body.slice(0, cut)
          const rendered = renderer
            ? htmlToPlain(await renderer.toHtml({ body: prefix, path, meta }))
            : htmlToPlain(prefix)
          return rendered.trim()
        }
      }
      return excerptOf(await plain(), options)
    },
    async toc(options: TocOptions = {}): Promise<TocEntry[]> {
      return buildToc(await headings(), options)
    },
    async readingTime(options: ReadingTimeOptions = {}): Promise<ReadingTime> {
      return readingTimeOf(await plain(), options)
    },
    async asset(url: string): Promise<string> {
      if (!input.resolveAsset) throw new MissingRendererError('ctx.asset()')
      const resolved = await input.resolveAsset(url)
      if (!resolved) throw new Error(`Asset not found relative to this document: ${url}`)
      return resolved.src
    },
    async image(url: string): Promise<Image> {
      if (!input.resolveImage) throw new MissingImageProcessorError()
      const resolved = await input.resolveImage(url)
      if (!resolved) throw new Error(`Image not found relative to this document: ${url}`)
      return resolved
    },
    skip(reason?: string): never {
      const signal: SkipSignal = { [SKIP]: true, reason }
      throw signal
    },

    documents: (collection => services().documents(collection)) as TransformContext['documents'],
    siblings: <T,>() => services().siblings() as Promise<T[]>,
    resolve: ((collection, id) => services().resolve(collection, id)) as TransformContext['resolve'],
    resolveMany: ((collection, ids) =>
      services().resolveMany(collection, ids)) as TransformContext['resolveMany'],
    reference: (collection: CollectionRef, id: string) => services().reference(collection, id),
    cache: <T,>(value: unknown, fn: () => Promise<T> | T, options?: { key?: string }) =>
      services().cache(value, fn, options),
    emitFile: (name: string, content: string | Uint8Array) => services().emitFile(name, content),
    addWatchFile: (path: string) => services().addWatchFile(path)
  }
}

export function isSkipSignal(value: unknown): value is SkipSignal {
  return typeof value === 'object' && value !== null && SKIP in value
}
