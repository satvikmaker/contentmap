import { reindent } from './emit.ts'
import { ts, unwrap } from './ts.ts'

/**
 * A tool's own completion callback, to be run by contentmap's `afterBuild`.
 *
 * contentlayer's `onSuccess(importData)`, velite's `complete(data)` and
 * content-collections' `onSuccess(documents)` all do the same job — work that
 * needs the whole corpus, done once the build has finished — and differ only
 * in what they are handed. So the callback is kept exactly as written, and
 * the argument it expected is rebuilt from contentmap's documents.
 */
export interface HookSource {
  /** The callback as written: an arrow, a function, a method, or a name. */
  fn: ts.Expression
  /**
   * What its first parameter received, rebuilt. Given the final collection
   * names — normalising can rename one — and the hook's context parameter.
   */
  argument(names: ReadonlyMap<string, string>, ctx: string): string
  /** One line saying what the argument is, for whoever reads the config. */
  comment: string
}

/**
 * The value of `afterBuild`, for one callback or several.
 *
 * Laid out for a property that starts two spaces in, as every property of
 * `defineConfig` does.
 */
export function afterBuildValue(
  sources: readonly HookSource[],
  names: ReadonlyMap<string, string>
): string {
  if (sources.length === 1) return afterBuildHook(sources[0]!, names, '  ')
  const hooks = sources.map(source => `    ${afterBuildHook(source, names, '    ')}`)
  return ['[', hooks.join(',\n'), '  ]'].join('\n')
}

/**
 * One `afterBuild` hook running a callback.
 *
 * A block-bodied callback with at most one plain parameter is inlined: the
 * parameter becomes a `const` holding the rebuilt argument, and the body
 * follows unchanged — which reads like something a person wrote. Anything
 * else is called as written, with the argument passed in.
 */
function afterBuildHook(
  source: HookSource,
  names: ReadonlyMap<string, string>,
  indent: string
): string {
  const node = (unwrap(source.fn) ?? source.fn) as ts.Node
  const text = node.getText()
  // Never shadow something the callback itself refers to.
  const ctx =
    ['ctx', 'context', 'build'].find(name => !new RegExp(`\\b${name}\\b`).test(text)) ?? 'hook'
  const argument = source.argument(names, ctx)
  const inner = `${indent}  `

  const fn =
    ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)
      ? node
      : undefined
  const first = fn?.parameters[0]
  if (
    fn?.body &&
    ts.isBlock(fn.body) &&
    fn.parameters.length <= 1 &&
    (first === undefined || ts.isIdentifier(first.name))
  ) {
    const lines = [`async ${ctx} => {`, `${inner}// ${source.comment}`]
    if (first) lines.push(`${inner}const ${first.name.getText()} = ${reindent(argument, inner)}`)
    const body = fn.body
      .getText()
      .slice(1, -1)
      .replace(/^\s*\n/, '')
      .replace(/\n\s*$/, '')
    if (body.trim() !== '') lines.push(indentLines(body, inner))
    lines.push(`${indent}}`)
    return lines.join('\n')
  }

  const callee =
    ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) ? text : callable(node)
  return [
    `async ${ctx} => {`,
    `${inner}// ${source.comment}`,
    `${inner}await ${callee}(${reindent(argument, inner)})`,
    `${indent}}`
  ].join('\n')
}

/** Every line of `code` moved to `indent`, relative indentation kept. */
function indentLines(code: string, indent: string): string {
  // reindent leaves its first line alone, so give it an empty one.
  return reindent(`\n${code}`, indent).slice(1)
}

/**
 * A function, as something that can be called in place, whatever form it was
 * written in.
 *
 * A method — `resolve(doc) { … }` — lifted out of its object is not an
 * expression, and wrapping its text in parentheses does not parse. It has to
 * become a function expression first.
 */
export function callable(node: ts.Node): string {
  if (ts.isMethodDeclaration(node)) {
    const isAsync = node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''
    const params = node.parameters.map(p => p.getText()).join(', ')
    const returns = node.type ? `: ${node.type.getText()}` : ''
    return `(${isAsync}function (${params})${returns} ${node.body?.getText() ?? '{}'})`
  }
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) return node.getText()
  return `(${node.getText()})`
}

/** `{ a: x, b: y }`, on one line when it fits and one entry a line when not. */
export function objectLiteral(entries: readonly [string, string][]): string {
  const inline = `{ ${entries.map(([key, value]) => `${key}: ${value}`).join(', ')} }`
  if (inline.length <= 72) return inline
  return ['{', entries.map(([key, value]) => `  ${key}: ${value}`).join(',\n'), '}'].join('\n')
}
