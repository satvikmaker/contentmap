import { parseJSON5, parseJSONC, parseTOML, parseYAML } from 'confbox'
import type { Parser, ParsedFile } from '../types.ts'
import { parseFrontmatterBlock, splitFrontmatter } from './frontmatter.ts'

/** Markdown-ish files: frontmatter plus a body. */
export const frontmatterParser: Parser = {
  name: 'frontmatter',
  extensions: ['.md', '.mdx', '.markdown'],
  hasBody: true,
  parse({ content }) {
    const { raw, format, body } = splitFrontmatter(content)
    const data = raw === null ? {} : parseFrontmatterBlock(raw, format)
    return { data, body: body.trim() }
  }
}

/** Same detection, body discarded — for the let-the-bundler-compile-MDX path. */
export const frontmatterOnlyParser: Parser = {
  name: 'frontmatter-only',
  extensions: [],
  hasBody: false,
  parse({ content }) {
    const { raw, format } = splitFrontmatter(content)
    return { data: raw === null ? {} : parseFrontmatterBlock(raw, format) }
  }
}

const structured = (
  name: string,
  extensions: readonly string[],
  parse: (s: string) => unknown
): Parser => ({
  name,
  extensions,
  hasBody: false,
  parse({ content }) {
    const value: unknown = content.trim() === '' ? {} : parse(content)
    return toRecords(value, name)
  }
})

export const yamlParser: Parser = structured('yaml', ['.yaml', '.yml'], parseYAML)
export const jsonParser: Parser = structured('json', ['.json'], parseJSON5)
export const jsoncParser: Parser = structured('jsonc', ['.jsonc'], parseJSONC)
export const tomlParser: Parser = structured('toml', ['.toml'], parseTOML)

export const rawParser: Parser = {
  name: 'raw',
  extensions: [],
  hasBody: true,
  parse({ content }) {
    return { data: {}, body: content }
  }
}

/**
 * An array at the document root yields N records from one file — that is how a
 * single `tags.yaml` becomes many tag documents.
 */
function toRecords(value: unknown, parser: string): ParsedFile | ParsedFile[] {
  if (Array.isArray(value)) {
    return value.map((item, i) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new TypeError(`${parser}: array item ${i} must be an object`)
      }
      return { data: item as Record<string, unknown> }
    })
  }
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`${parser}: expected an object or array at the document root`)
  }
  return { data: value as Record<string, unknown> }
}

export const builtinParsers: readonly Parser[] = [
  frontmatterParser,
  yamlParser,
  jsonParser,
  jsoncParser,
  tomlParser
]

const BY_NAME: ReadonlyMap<string, Parser> = new Map(
  [
    frontmatterParser,
    frontmatterOnlyParser,
    yamlParser,
    jsonParser,
    jsoncParser,
    tomlParser,
    rawParser
  ].map(p => [p.name, p])
)

/**
 * Pick a parser for one file.
 *
 * Dispatch is per-file by extension, not fixed per collection. Content
 * Collections fixes one parser per collection, so a collection matching both
 * *.md and *.json feeds the JSON through gray-matter and fails validation.
 */
export function resolveParser(
  extension: string,
  override: string | Parser | undefined,
  userParsers: readonly Parser[]
): Parser | undefined {
  if (override !== undefined) {
    if (typeof override !== 'string') return override
    const named = userParsers.find(p => p.name === override) ?? BY_NAME.get(override)
    if (!named) throw new TypeError(`Unknown parser "${override}"`)
    return named
  }
  const ext = extension.toLowerCase()
  return (
    userParsers.find(p => p.extensions.includes(ext)) ??
    builtinParsers.find(p => p.extensions.includes(ext))
  )
}
