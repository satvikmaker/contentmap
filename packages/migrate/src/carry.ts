import { relative, resolve, sep } from 'node:path'
import { ts } from './ts.ts'

/**
 * Bring along what moved code refers to.
 *
 * A computed field that calls `readingTime(doc.body.raw)` is only half moved if
 * `readingTime` stays behind: the generated config names something it never
 * imports and fails on its first build. So every name the emitted code uses is
 * traced to the top-level declaration that bound it — an import, a `const`, a
 * function — and carried across along with whatever that in turn needs.
 *
 * Scope-aware on purpose. A resolver's own `doc` parameter, or a `const` it
 * declares, is not a reference to anything at the top of the file, and
 * treating it as one would import things the code never used.
 */

interface ImportBinding {
  kind: 'import'
  statement: ts.ImportDeclaration
  module: string
}

interface LocalBinding {
  kind: 'local'
  statement: ts.Statement
}

export type Binding = ImportBinding | LocalBinding

/** Every name bound at the top level of a file, and the statement that binds it. */
export function topLevelBindings(file: ts.SourceFile): Map<string, Binding> {
  const out = new Map<string, Binding>()
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (!clause || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const binding: ImportBinding = {
        kind: 'import',
        statement,
        module: statement.moduleSpecifier.text
      }
      if (clause.name) out.set(clause.name.text, binding)
      const named = clause.namedBindings
      if (named && ts.isNamespaceImport(named)) out.set(named.name.text, binding)
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) out.set(element.name.text, binding)
      }
      continue
    }
    const local: LocalBinding = { kind: 'local', statement }
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        for (const name of bindingNames(decl.name)) out.set(name, local)
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name
    ) {
      out.set(statement.name.text, local)
    } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
      out.set(statement.name.text, local)
    } else if (ts.isImportEqualsDeclaration(statement)) {
      out.set(statement.name.text, local)
    }
  }
  return out
}

/** Names a binding pattern declares: `{ a, b: [c] }` declares a and c. */
export function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  const out: string[] = []
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue
    out.push(...bindingNames(element.name))
  }
  return out
}

/** Names used inside `root` that nothing inside `root` declares. */
export function freeIdentifiers(root: ts.Node): Set<string> {
  const out = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isReference(node) && !isBoundWithin(node, root)) {
      out.add(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return out
}

/**
 * Whether an identifier reads a binding, as opposed to naming a property or
 * declaring something.
 */
export function isReference(id: ts.Identifier): boolean {
  const parent = id.parent
  if (!parent) return true
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === id
  if (ts.isQualifiedName(parent)) return parent.left === id
  if (ts.isBindingElement(parent)) return parent.initializer === id
  if (ts.isShorthandPropertyAssignment(parent)) return true
  if (ts.isMetaProperty(parent)) return false
  if (
    ts.isLabeledStatement(parent) ||
    ts.isBreakStatement(parent) ||
    ts.isContinueStatement(parent)
  ) {
    return false
  }
  // Every declaration-like parent names its own thing with `name`.
  const named = parent as { name?: ts.Node }
  if (named.name === id) {
    return !(
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isExportSpecifier(parent) ||
      ts.isJsxAttribute(parent) ||
      ts.isNamedTupleMember(parent)
    )
  }
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false
  return true
}

/** Whether something between `id` and `root` (inclusive) declares `id`. */
export function isBoundWithin(id: ts.Identifier, root: ts.Node): boolean {
  // `resolve: slugOf` and `schema: base` hand over the identifier itself as
  // the root. Nothing inside it can declare it; walking up from its parent
  // would never meet the root, reach the file, find the top-level declaration,
  // and call a reference to it local — so it was never carried.
  if (id === root) return false
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    if (declares(scope, id.text)) return true
    if (scope === root) return false
  }
  return false
}

function declares(scope: ts.Node, name: string): boolean {
  if (ts.isFunctionLike(scope)) {
    if (scope.parameters.some(p => bindingNames(p.name).includes(name))) return true
    if (scope.typeParameters?.some(t => t.name.text === name)) return true
    // A named function expression can call itself by name.
    if (ts.isFunctionExpression(scope) && scope.name?.text === name) return true
    const body = (scope as { body?: ts.Node }).body
    return body !== undefined && ts.isBlock(body) && hoistsVar(body, name)
  }
  if (
    ts.isBlock(scope) ||
    ts.isSourceFile(scope) ||
    ts.isModuleBlock(scope) ||
    ts.isCaseClause(scope) ||
    ts.isDefaultClause(scope)
  ) {
    return statementsDeclare(scope.statements, name)
  }
  if (ts.isCaseBlock(scope)) {
    return scope.clauses.some(clause => statementsDeclare(clause.statements, name))
  }
  if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    const init = scope.initializer
    return (
      init !== undefined &&
      ts.isVariableDeclarationList(init) &&
      init.declarations.some(d => bindingNames(d.name).includes(name))
    )
  }
  if (ts.isCatchClause(scope)) {
    const variable = scope.variableDeclaration
    return variable !== undefined && bindingNames(variable.name).includes(name)
  }
  if (
    ts.isClassLike(scope) ||
    ts.isInterfaceDeclaration(scope) ||
    ts.isTypeAliasDeclaration(scope)
  ) {
    if (ts.isClassExpression(scope) && scope.name?.text === name) return true
    return scope.typeParameters?.some(t => t.name.text === name) ?? false
  }
  if (ts.isMappedTypeNode(scope)) return scope.typeParameter.name.text === name
  return false
}

function statementsDeclare(statements: ts.NodeArray<ts.Statement>, name: string): boolean {
  for (const statement of statements) {
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(d => bindingNames(d.name).includes(name))
    ) {
      return true
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return true
    }
  }
  return false
}

/** `var` anywhere in a function body, short of a nested function, belongs to it. */
function hoistsVar(body: ts.Block, name: string): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node)) return
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.BlockScoped) === 0 &&
      node.declarations.some(d => bindingNames(d.name).includes(name))
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(body, visit)
  return found
}

export interface CarryOptions {
  /** Import sources that belong to the tool being migrated away from. */
  isToolModule(module: string): boolean
  /**
   * Statements the translator already rewrote into the new config, such as
   * collection definitions. The generated file declares its own version, so
   * the original must not come along as well.
   */
  isTranslated(statement: ts.Statement): boolean
  /** Names the generated file declares itself, e.g. its collections. */
  generated: ReadonlySet<string>
  /** Names the generated file imports itself, and from where. */
  provided?: ReadonlyMap<string, string>
  /** Tool imports the translation rewrites away — velite's `s`, which becomes `z`. */
  rewritten?: ReadonlySet<string>
  /** Applied to each carried declaration, so it uses the new vocabulary too. */
  rewrite?(text: string): string
  /** Directory of the original config. */
  from: string
  /** Directory the generated config is written to. */
  to: string
}

export interface Carried {
  /** Import statements, in source order, with only the names still used. */
  imports: string[]
  /** Top-level declarations, in source order, with their leading comments. */
  declarations: string[]
  /** Every name the carried code binds at the top of the new file. */
  names: Set<string>
  /** Names that point into the tool being replaced, and where they came from. */
  unresolved: { name: string; module: string | undefined }[]
}

export function carry(
  file: ts.SourceFile,
  roots: readonly ts.Node[],
  options: CarryOptions
): Carried {
  const bindings = topLevelBindings(file)
  const imported = new Map<ts.ImportDeclaration, Set<string>>()
  const statements = new Set<ts.Statement>()
  const unresolved = new Map<string, string | undefined>()
  const seen = new Set<string>()

  const need = (node: ts.Node): void => {
    for (const name of freeIdentifiers(node)) {
      if (seen.has(name)) continue
      seen.add(name)
      const binding = bindings.get(name)
      // Not bound at the top of the file: a global such as process or JSON.
      if (!binding) continue
      if (binding.kind === 'import') {
        // The generated file already imports this, from the same place.
        if (options.provided?.get(name) === binding.module) continue
        if (options.isToolModule(binding.module)) {
          if (!options.rewritten?.has(name)) unresolved.set(name, binding.module)
          continue
        }
        let names = imported.get(binding.statement)
        if (!names) imported.set(binding.statement, (names = new Set()))
        names.add(name)
        continue
      }
      if (options.isTranslated(binding.statement)) {
        // The generated file declares this under the same name, or it is
        // gone and whatever used it has to be told.
        if (!options.generated.has(name)) unresolved.set(name, undefined)
        continue
      }
      if (statements.has(binding.statement)) continue
      statements.add(binding.statement)
      need(binding.statement)
    }
  }
  for (const root of roots) need(root)

  const imports: string[] = []
  const declarations: string[] = []
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
      const module = statement.moduleSpecifier.text
      if (options.isToolModule(module)) continue
      const specifier = rebase(module, options.from, options.to)
      // A bare `import 'dotenv/config'` exists for its side effect, which the
      // carried code may well depend on. It costs nothing to keep.
      if (!statement.importClause) {
        imports.push(`import ${quote(specifier)}${attributesOf(statement)}`)
        continue
      }
      const names = imported.get(statement)
      if (names) imports.push(renderImport(statement, names, specifier))
      continue
    }
    if (!statements.has(statement)) continue
    let body = [...leadingComments(file, statement), statement.getText()].join('\n')
    if (options.rewrite) body = options.rewrite(body)
    declarations.push(body)
  }

  const names = new Set<string>()
  for (const [name, binding] of bindings) {
    if (
      binding.kind === 'import'
        ? imported.get(binding.statement)?.has(name)
        : statements.has(binding.statement)
    ) {
      names.add(name)
    }
  }

  return {
    imports,
    declarations,
    names,
    unresolved: [...unresolved].map(([name, module]) => ({ name, module }))
  }
}

/** Re-point a relative specifier at the same file, from the new config's directory. */
export function rebase(specifier: string, from: string, to: string): string {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return specifier
  if (resolve(from) === resolve(to)) return specifier
  const moved = relative(resolve(to), resolve(from, specifier)).split(sep).join('/')
  return moved.startsWith('.') ? moved : `./${moved}`
}

function renderImport(
  statement: ts.ImportDeclaration,
  names: ReadonlySet<string>,
  specifier: string
): string {
  const clause = statement.importClause!
  const parts: string[] = []
  if (clause.name && names.has(clause.name.text)) parts.push(clause.name.text)
  const bindings = clause.namedBindings
  if (bindings && ts.isNamespaceImport(bindings) && names.has(bindings.name.text)) {
    parts.push(`* as ${bindings.name.text}`)
  }
  if (bindings && ts.isNamedImports(bindings)) {
    const kept = bindings.elements
      .filter(element => names.has(element.name.text))
      .map(element => {
        const type = element.isTypeOnly ? 'type ' : ''
        const from = element.propertyName ? `${element.propertyName.getText()} as ` : ''
        return `${type}${from}${element.name.text}`
      })
    if (kept.length > 0) parts.push(`{ ${kept.join(', ')} }`)
  }
  const type = clause.isTypeOnly ? 'type ' : ''
  return `import ${type}${parts.join(', ')} from ${quote(specifier)}${attributesOf(statement)}`
}

function attributesOf(statement: ts.ImportDeclaration): string {
  return statement.attributes ? ` ${statement.attributes.getText()}` : ''
}

function leadingComments(file: ts.SourceFile, statement: ts.Statement): string[] {
  const ranges = ts.getLeadingCommentRanges(file.text, statement.getFullStart()) ?? []
  return ranges.map(range => file.text.slice(range.pos, range.end))
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
