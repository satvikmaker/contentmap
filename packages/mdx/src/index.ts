import { pathToFileURL } from 'node:url'
import { compile } from '@mdx-js/mdx'
import type { MdxCompiler, RenderInput } from 'contentmap'

export interface MdxOptions {
  /** remark plugins, applied before the MDX AST is turned into JSX. */
  remarkPlugins?: readonly unknown[]
  /** rehype plugins, applied to the HTML AST. */
  rehypePlugins?: readonly unknown[]
  /** recma plugins, applied to the resulting JavaScript AST. */
  recmaPlugins?: readonly unknown[]
  /**
   * Development build: adds source positions so errors point at the `.mdx`
   * file rather than at generated code.
   */
  development?: boolean
}

/**
 * MDX compiler for contentmap.
 *
 * Emits a JavaScript **function body**, not a component, because a build can
 * only write data and a component does not exist until a JSX runtime has
 * evaluated it. The string goes into your document like any other field; the
 * consumer turns it into a component with `run()` and their own runtime:
 *
 * ```ts
 * import { run } from '@mdx-js/mdx'
 * import * as runtime from 'react/jsx-runtime'
 *
 * const { default: Content } = await run(doc.code, { ...runtime, baseUrl: import.meta.url })
 * ```
 *
 * `run` evaluates JavaScript, which is how every tool in this space renders
 * MDX — contentlayer, velite and content-collections all ship the same
 * function-body string. contentmap's own runtime still contains no `eval` and
 * is unaffected: this is opt-in, lives in its own package, and a project that
 * never imports it never pays for it.
 */
export function mdx(options: MdxOptions = {}): MdxCompiler {
  return {
    name: 'mdx',
    async compile(input: RenderInput, callOptions?: unknown): Promise<string> {
      const merged = { ...options, ...(callOptions as MdxOptions | undefined) }
      const file = await compile(
        // The path is passed so plugins and error messages can name the real
        // file rather than an anonymous buffer.
        { value: input.body, path: input.path },
        {
          outputFormat: 'function-body',
          // Required from MDX v3 whenever the output is a function body.
          // node:url rather than hand-rolling it: a Windows drive letter has to
          // stay `C:` and not become `C%3A`, or relative imports inside the MDX
          // resolve against a base URL the platform does not recognise. This
          // only ever runs in a build, so the builtin costs nothing.
          baseUrl: pathToFileURL(input.path).href,
          development: merged.development ?? false,
          ...(merged.remarkPlugins ? { remarkPlugins: merged.remarkPlugins as never } : {}),
          ...(merged.rehypePlugins ? { rehypePlugins: merged.rehypePlugins as never } : {}),
          ...(merged.recmaPlugins ? { recmaPlugins: merged.recmaPlugins as never } : {})
        }
      )
      return String(file)
    }
  }
}

export default mdx
