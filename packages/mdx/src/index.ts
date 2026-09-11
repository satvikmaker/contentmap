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
  /**
   * Make the output run under mdx-bundler's `getMDXComponent` as well.
   *
   * contentlayer and content-collections compiled with mdx-bundler, and the
   * pages built on them render with `getMDXComponent(code)` or a hook wrapping
   * it — `useMDXComponent` from next-contentlayer, pliny's
   * `MDXLayoutRenderer`. That calls the code with React, ReactDOM and the JSX
   * runtime as *named parameters*, where `run()` passes the runtime as the
   * first argument. With `'mdx-bundler'` the code accepts either, so a
   * migrated site keeps rendering without touching a page, and `run()` still
   * works.
   */
  compat?: 'mdx-bundler'
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
      const body = String(file)
      return merged.compat === 'mdx-bundler' ? bundlerCompatible(body) : body
    }
  }
}

/**
 * Wrap a function body so it runs under both calling conventions.
 *
 * `run()` evaluates the body with the runtime as `arguments[0]`.
 * `getMDXComponent` evaluates it with `React, ReactDOM, _jsx_runtime, …` as
 * named parameters, so `arguments[0]` is React — which has no `jsx` — and the
 * page throws. The whole body moves into an inner function that is handed
 * whichever runtime is present. Rewriting the `arguments[0]` it reads instead
 * would also rewrite any code sample in the document that mentions it.
 */
function bundlerCompatible(body: string): string {
  return (
    'return (function () {\n' +
    body +
    '\n})(typeof _jsx_runtime === "undefined" ? arguments[0] : _jsx_runtime)\n'
  )
}

export default mdx
