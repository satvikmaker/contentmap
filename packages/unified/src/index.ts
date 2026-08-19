import rehypeSlug from 'rehype-slug'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified, type Plugin } from 'unified'
import type { Renderer, RenderInput } from 'contentmap'

export interface UnifiedOptions {
  /** GitHub Flavored Markdown. Default true. */
  gfm?: boolean
  /** Add an `id` to every heading. Default true. */
  headingIds?: boolean
  /**
   * Pass raw HTML in the source through to the output.
   *
   * Off by default: `rehype-raw` pulls in parse5 for roughly +10 packages and
   * +2 MB, which most content does not need, and passing arbitrary HTML through
   * is a decision worth making explicitly.
   */
  allowDangerousHtml?: boolean
  remarkPlugins?: readonly Plugin[]
  rehypePlugins?: readonly Plugin[]
}

/**
 * The remark/rehype renderer.
 *
 * Measurably the slowest option — roughly 100x marked on the same document —
 * but it is the only one with the plugin ecosystem, which for many projects is
 * the deciding factor.
 */
export function unifiedRenderer(options: UnifiedOptions = {}): Renderer {
  const build = async () => {
    const processor: any = unified().use(remarkParse)
    if (options.gfm ?? true) processor.use(remarkGfm)
    for (const plugin of options.remarkPlugins ?? []) processor.use(plugin)
    processor.use(remarkRehype, {
      allowDangerousHtml: options.allowDangerousHtml ?? false
    })
    if (options.allowDangerousHtml) {
      // Optional peer: only the projects that actually pass raw HTML through
      // pay for parse5.
      const mod = (await import('rehype-raw').catch(() => {
        throw new Error(
          'allowDangerousHtml requires the `rehype-raw` package. Install it, or leave the option off.'
        )
      })) as unknown as { default: Plugin }
      processor.use(mod.default)
    }
    if (options.headingIds ?? true) processor.use(rehypeSlug)
    for (const plugin of options.rehypePlugins ?? []) processor.use(plugin)
    processor.use(rehypeStringify, { allowDangerousHtml: options.allowDangerousHtml ?? false })
    return processor.freeze()
  }

  // Built once, lazily: assembling the processor is the expensive part, and a
  // frozen unified pipeline is safe to reuse across documents.
  let pipeline: Promise<Awaited<ReturnType<typeof build>>> | undefined
  return {
    name: 'unified',
    async toHtml(input: RenderInput): Promise<string> {
      pipeline ??= build()
      const processor = await pipeline
      const file = await processor.process({ value: input.body, path: input.path })
      return String(file)
    }
  }
}

export default unifiedRenderer
