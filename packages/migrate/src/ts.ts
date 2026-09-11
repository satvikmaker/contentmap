import ts from 'typescript'

/**
 * Parse without type-checking.
 *
 * A codemod only needs the shape of the config, and a full program would need
 * the user's whole dependency graph to resolve — which is exactly the thing
 * their project may no longer be able to install.
 */
export function parse(source: string, fileName = 'config.ts'): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** Every node in the tree, depth first. */
export function* walk(node: ts.Node): Generator<ts.Node> {
  yield node
  for (const child of node.getChildren()) yield* walk(child)
}

/** Calls to a named function anywhere in the file. */
export function callsTo(file: ts.SourceFile, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = []
  for (const node of walk(file)) {
    if (!ts.isCallExpression(node)) continue
    const target = node.expression
    const called = ts.isIdentifier(target)
      ? target.text
      : ts.isPropertyAccessExpression(target)
        ? target.name.text
        : undefined
    if (called === name) out.push(node)
  }
  return out
}

/** Source text of a node, exactly as written. */
export function text(node: ts.Node): string {
  return node.getText()
}

/** A node's text, cut down to something that fits in a sentence. */
export function short(node: ts.Node, max = 60): string {
  const flat = node.getText().replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Property of an object literal, by name.
 *
 * Handles shorthand (`{ posts }`) as well as `{ posts: posts }`, because both
 * appear in real configs.
 */
export function prop(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const member of object.properties) {
    if (ts.isPropertyAssignment(member) && nameOf(member.name) === name) return member.initializer
    if (ts.isShorthandPropertyAssignment(member) && member.name.text === name) return member.name
    if (ts.isMethodDeclaration(member) && nameOf(member.name) === name) {
      // `transform(doc) { … }` and `transform: doc => …` mean the same thing to
      // the tool that reads them, so they have to mean the same thing here.
      return member as unknown as ts.Expression
    }
  }
  return undefined
}

export function nameOf(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  if (ts.isNumericLiteral(name)) return name.text
  if (ts.isNoSubstitutionTemplateLiteral(name)) return name.text
  return undefined
}

/** A string literal's value, or undefined if it is not a literal. */
export function stringOf(node: ts.Expression | undefined): string | undefined {
  const inner = unwrap(node)
  if (inner && ts.isStringLiteral(inner)) return inner.text
  if (inner && ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text
  return undefined
}

export function booleanOf(node: ts.Expression | undefined): boolean | undefined {
  const inner = unwrap(node)
  if (inner?.kind === ts.SyntaxKind.TrueKeyword) return true
  if (inner?.kind === ts.SyntaxKind.FalseKeyword) return false
  return undefined
}

/**
 * Strip the wrappers that change a value's type but not the value.
 *
 * `{ … } as const`, `{ … } satisfies Fields` and `(…)` are all the same object
 * to the tool that reads them. Missing `satisfies` made a config written in
 * current TypeScript look like it had no fields at all.
 */
export function unwrap(node: ts.Expression | undefined): ts.Expression | undefined {
  let current = node
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current))
  ) {
    current = current.expression
  }
  return current
}

/** Object literal, looking through the wrappers `unwrap` removes. */
export function objectOf(node: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
  const inner = unwrap(node)
  return inner && ts.isObjectLiteralExpression(inner) ? inner : undefined
}

/** The top-level `const`, `let` or `var` that declared a name. */
export function declarationOf(
  file: ts.SourceFile,
  name: string
): ts.VariableDeclaration | undefined {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl
    }
  }
  return undefined
}

/**
 * Resolve an expression to the object literal it stands for.
 *
 * Configs almost always read `const posts = defineCollection({…})` followed by
 * `defineConfig({ collections: { posts } })`, so following the binding is not
 * an optional nicety. Aliases (`const a = b`) are followed too, a bounded
 * number of times.
 */
export function resolveObject(
  file: ts.SourceFile,
  node: ts.Expression | undefined,
  depth = 0
): ts.ObjectLiteralExpression | undefined {
  const direct = objectOf(node)
  if (direct) return direct
  const inner = unwrap(node)
  if (!inner || depth > 8) return undefined

  // `collections: [defineCollection({ … })]` — inline, never given a name.
  // Missing this dropped the collection silently and produced a config with
  // none in it, which is the worst thing a migration can do.
  if (ts.isCallExpression(inner)) return fromCall(inner)

  if (!ts.isIdentifier(inner)) return undefined
  return resolveObject(file, declarationOf(file, inner.text)?.initializer, depth + 1)
}

/** Array literal, following a binding the same way `resolveObject` does. */
export function resolveArray(
  file: ts.SourceFile,
  node: ts.Expression | undefined,
  depth = 0
): ts.ArrayLiteralExpression | undefined {
  const inner = unwrap(node)
  if (!inner || depth > 8) return undefined
  if (ts.isArrayLiteralExpression(inner)) return inner
  if (!ts.isIdentifier(inner)) return undefined
  return resolveArray(file, declarationOf(file, inner.text)?.initializer, depth + 1)
}

/**
 * The object a definition call was given.
 *
 * contentlayer wraps its definition in a thunk so that `reference` fields can
 * name a type declared later, so the argument is unwrapped either way.
 */
function fromCall(call: ts.CallExpression): ts.ObjectLiteralExpression | undefined {
  const first = call.arguments[0]
  if (!first) return undefined
  const object = objectOf(first)
  if (object) return object
  const fn = unwrap(first)
  if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
    const body = fn.body
    if (!ts.isBlock(body)) return objectOf(body)
    for (const statement of body.statements) {
      if (ts.isReturnStatement(statement)) {
        const returned = objectOf(statement.expression)
        if (returned) return returned
      }
    }
  }
  return undefined
}

/** One property of an object literal, as JavaScript would see it. */
export interface Entry {
  name: string
  /**
   * The value as written. For a shorthand this is the identifier itself, which
   * `resolveObject` follows to its declaration.
   */
  value: ts.Expression
  node: ts.Node
}

/**
 * An object literal's properties, with spreads and shorthands followed.
 *
 * Real configs share definitions: `computedFields: { ...shared, slug: … }`, or
 * `computedFields,` naming a const declared above. Reading only `key: value`
 * members dropped every field that arrived another way, and said nothing — on
 * the first real config it was pointed at, five of six computed fields
 * vanished. Anything that cannot be followed is handed to `onUnresolved`, so a
 * caller can report it rather than lose it.
 *
 * Later properties win and the first position is kept, as in JavaScript.
 */
export function entriesOf(
  file: ts.SourceFile,
  object: ts.ObjectLiteralExpression,
  onUnresolved: (node: ts.Node) => void
): Entry[] {
  const out = new Map<string, Entry>()
  const visit = (current: ts.ObjectLiteralExpression, seen: ReadonlySet<ts.Node>): void => {
    // A spread that reaches back to itself would otherwise never terminate.
    if (seen.has(current)) return
    const next = new Set(seen).add(current)
    for (const member of current.properties) {
      if (ts.isSpreadAssignment(member)) {
        const spread = resolveObject(file, member.expression)
        if (spread) visit(spread, next)
        else onUnresolved(member)
        continue
      }
      if (ts.isShorthandPropertyAssignment(member)) {
        out.set(member.name.text, { name: member.name.text, value: member.name, node: member })
        continue
      }
      const name = nameOf(member.name)
      if (name === undefined) {
        // A computed key, `[key]: …`, cannot be named without running the code.
        onUnresolved(member)
        continue
      }
      if (ts.isPropertyAssignment(member)) {
        out.set(name, { name, value: member.initializer, node: member })
      } else if (ts.isMethodDeclaration(member)) {
        out.set(name, { name, value: member as unknown as ts.Expression, node: member })
      } else {
        onUnresolved(member)
      }
    }
  }
  visit(object, new Set())
  return [...out.values()]
}

/** Elements of an array literal, with spreads of other arrays followed. */
export function elementsOf(
  file: ts.SourceFile,
  array: ts.ArrayLiteralExpression,
  onUnresolved: (node: ts.Node) => void
): ts.Expression[] {
  const out: ts.Expression[] = []
  const visit = (current: ts.ArrayLiteralExpression, seen: ReadonlySet<ts.Node>): void => {
    if (seen.has(current)) return
    const next = new Set(seen).add(current)
    for (const element of current.elements) {
      if (ts.isOmittedExpression(element)) continue
      if (ts.isSpreadElement(element)) {
        const spread = resolveArray(file, element.expression)
        if (spread) visit(spread, next)
        else onUnresolved(element)
        continue
      }
      out.push(element)
    }
  }
  visit(array, new Set())
  return out
}

export { ts }
