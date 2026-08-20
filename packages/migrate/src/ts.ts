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
  return undefined
}

/** A string literal's value, or undefined if it is not a literal. */
export function stringOf(node: ts.Expression | undefined): string | undefined {
  if (node && ts.isStringLiteral(node)) return node.text
  if (node && ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return undefined
}

export function booleanOf(node: ts.Expression | undefined): boolean | undefined {
  if (node?.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node?.kind === ts.SyntaxKind.FalseKeyword) return false
  return undefined
}

/** Object literal, following one level of `as const` / parentheses. */
export function objectOf(node: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
  let current = node
  while (current) {
    if (ts.isObjectLiteralExpression(current)) return current
    if (ts.isAsExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression
      continue
    }
    return undefined
  }
  return undefined
}

/**
 * Resolve an identifier to the object literal it was declared with.
 *
 * Configs almost always read `const posts = defineCollection({…})` followed by
 * `defineConfig({ collections: { posts } })`, so following the binding is not
 * an optional nicety.
 */
export function resolveObject(
  file: ts.SourceFile,
  node: ts.Expression | undefined
): ts.ObjectLiteralExpression | undefined {
  const direct = objectOf(node)
  if (direct) return direct
  if (!node || !ts.isIdentifier(node)) return undefined

  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== node.text) continue
      const init = decl.initializer
      const object = objectOf(init)
      if (object) return object
      // `const posts = defineCollection({ … })` — the argument is the object.
      if (init && ts.isCallExpression(init) && init.arguments.length > 0) {
        const arg = objectOf(init.arguments[0])
        if (arg) return arg
        // contentlayer wraps its definition in a thunk.
        const thunk = init.arguments[0]
        if (thunk && (ts.isArrowFunction(thunk) || ts.isFunctionExpression(thunk))) {
          const body = thunk.body
          if (ts.isBlock(body)) {
            for (const s of body.statements) {
              if (ts.isReturnStatement(s)) {
                const returned = objectOf(s.expression)
                if (returned) return returned
              }
            }
          } else {
            const returned = objectOf(body)
            if (returned) return returned
          }
        }
      }
    }
  }
  return undefined
}

export { ts }
