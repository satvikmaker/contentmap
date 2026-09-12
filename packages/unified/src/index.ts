import rehypeSlug from 'rehype-slug'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified, type Plugin } from 'unified'
import type { Renderer, RenderInput } from 'contentmap'

/**
 * A plugin, or a plugin with its options.
 *
 * `[plugin, options]` is how every remark/rehype config in the ecosystem
 * configures a plugin, so it has to be accepted here too.
 */
export type UnifiedPlugin = Plugin | readonly [Plugin, ...unknown[]]

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
  remarkPlugins?: readonly UnifiedPlugin[]
  rehypePlugins?: readonly UnifiedPlugin[]
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
    // `use(x)` reads a bare array as a list of pluggables, so a
    // `[plugin, options]` tuple has to be spread into `use(plugin, options)`
    // — handed over whole, the options object is read as an empty preset and
    // unified refuses it.
    const add = (processor: any, plugin: UnifiedPlugin) =>
      Array.isArray(plugin) ? processor.use(...plugin) : processor.use(plugin)

    const processor: any = unified().use(remarkParse)
    if (options.gfm ?? true) processor.use(remarkGfm)
    for (const plugin of options.remarkPlugins ?? []) add(processor, plugin)
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
    for (const plugin of options.rehypePlugins ?? []) add(processor, plugin)
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
