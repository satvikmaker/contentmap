import type {
  DocumentMeta,
  ExcerptOptions,
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
import { buildToc, excerptOf, htmlToHeadings, htmlToPlain, readingTimeOf } from './derive.ts'

export class MissingRendererError extends Error {
  override readonly name = 'MissingRendererError'
  readonly hint: string
  constructor(what: string) {
    super(`No renderer configured, but ${what} was called`)
    this.hint =
      'Install a renderer and set it in your config: `import markdown from "@contentmap/markdown"` then `renderer: markdown()`.'
  }
}

export interface ContextInput {
  meta: DocumentMeta
  body: string
  path: string
  renderer: Renderer | undefined
  logger: Logger
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
  const renderInput = { body, path, meta }

  let htmlPromise: Promise<string> | undefined
  let plainPromise: Promise<string> | undefined
  let headingsPromise: Promise<readonly Heading[]> | undefined

  const markdown = (options?: unknown): Promise<string> => {
    if (!renderer) return Promise.reject(new MissingRendererError('ctx.markdown()'))
    // Options bypass the cache: a caller asking for different output should get
    // it rather than whatever the first call happened to request.
    if (options !== undefined) return Promise.resolve(renderer.toHtml(renderInput, options))
    htmlPromise ??= Promise.resolve(renderer.toHtml(renderInput))
    return htmlPromise
  }

  const plain = (): Promise<string> => {
    plainPromise ??= (async () => {
      if (renderer?.toPlain) return await renderer.toPlain(renderInput)
      if (renderer) return htmlToPlain(await markdown())
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
      return htmlToHeadings(await markdown())
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
      return excerptOf(await plain(), body, options)
    },
    async toc(options: TocOptions = {}): Promise<TocEntry[]> {
      return buildToc(await headings(), options)
    },
    async readingTime(options: ReadingTimeOptions = {}): Promise<ReadingTime> {
      return readingTimeOf(await plain(), options)
    },
    skip(reason?: string): never {
      const signal: SkipSignal = { [SKIP]: true, reason }
      throw signal
    }
  }
}

export function isSkipSignal(value: unknown): value is SkipSignal {
  return typeof value === 'object' && value !== null && SKIP in value
}
