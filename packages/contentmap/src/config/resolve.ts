import { stat } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  BuilderOptions,
  CollectionDefinition,
  ResolvedConfig,
  ResolvedOutput,
  UserConfig,
  ResolvedCollection
} from '../types.ts'
import { DEFAULT_ASSET_EXTENSIONS } from '../assets/index.ts'
import { isIdentifier } from '../utils/paths.ts'
import { loadModule } from './load.ts'

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
  readonly hint: string | undefined
  /** Config file this concerns, when known. Never guessed from a stack trace. */
  readonly file: string | undefined
  constructor(message: string, hint?: string, file?: string) {
    super(message)
    this.hint = hint
    this.file = file
  }
}

const CONFIG_NAMES = [
  'contentmap.config.ts',
  'contentmap.config.mts',
  'contentmap.config.js',
  'contentmap.config.mjs'
]

/**
 * Find the config in the project root only.
 *
 * Deliberately does NOT walk up parent directories: velite recurses three
 * levels and can silently pick up a monorepo parent's config, which produces
 * baffling output in a workspace.
 */
export async function findConfig(root: string): Promise<string> {
  for (const name of CONFIG_NAMES) {
    const candidate = resolve(root, name)
    try {
      const s = await stat(candidate)
      if (s.isFile()) return candidate
    } catch {
      // next candidate
    }
  }
  throw new ConfigError(
    `No contentmap config found in ${root}`,
    `Create one of: ${CONFIG_NAMES.join(', ')} — or pass --config <path>.`
  )
}

const DEFAULT_HEAVY = ['content', 'html', 'mdx', 'body', 'raw'] as const

export async function resolveConfig(options: BuilderOptions = {}): Promise<ResolvedConfig> {
  const cwd = options.root ? resolve(options.root) : process.cwd()
  const configPath = options.config
    ? isAbsolute(options.config)
      ? options.config
      : resolve(cwd, options.config)
    : await findConfig(cwd)

  const loaded = await loadModule(configPath)
  const user = loaded.value as UserConfig | undefined

  if (!user || typeof user !== 'object') {
    throw new ConfigError(
      'Config has no default export',
      'Export your config as default: `export default defineConfig({ ... })`',
      configPath
    )
  }
  if (!user.collections || typeof user.collections !== 'object') {
    throw new ConfigError(
      'Config does not define any collections',
      'Add a `collections` object: `defineConfig({ collections: { posts } })`',
      configPath
    )
  }

  const base = user.root ? resolve(dirname(configPath), user.root) : dirname(configPath)
  const out = user.output ?? {}
  const dir = resolve(base, options.outDir ?? out.dir ?? '.contentmap')
  const output: ResolvedOutput = {
    dir,
    cacheDir: resolve(base, options.cacheDir ?? out.cacheDir ?? join(dir, '.cache')),
    assets: resolve(base, out.assets ?? 'public/_content'),
    assetsBase: out.assetsBase ?? '/_content/',
    assetsName: out.assetsName ?? '[name]-[hash:8].[ext]',
    format: options.format ?? out.format ?? 'modules',
    types: out.types ?? 'trampoline',
    clean: options.clean ?? out.clean ?? false
  }

  if (output.cacheDir === output.dir) {
    // Otherwise `clean` has no honest move: removing the directory destroys
    // the cache, and keeping it makes --clean a silent no-op. Failing here is
    // the only outcome that cannot surprise anyone later.
    throw new ConfigError(
      'output.cacheDir must not be the output directory itself',
      'Point it at a subdirectory such as `.contentmap/.cache` (the default), or somewhere outside the output entirely.',
      configPath
    )
  }

  if (out.types === 'explicit') {
    throw new ConfigError(
      "output.types: 'explicit' is not implemented yet",
      "Use 'trampoline' (the default) or false. Explicit structural .d.ts emission is planned: https://github.com/satvikmaker/contentmap/blob/main/ROADMAP.md"
    )
  }

  const collections = validateCollections(user.collections, base)

  return {
    dryRun: options.dryRun ?? false,
    frozen: options.frozen ?? false,
    root: base,
    configPath,
    configDeps: loaded.deps,
    configDigest: loaded.digest,
    collections,
    output,
    parsers: user.parsers ?? [],
    renderer: user.renderer,
    images: user.images,
    assetExtensions: (user.assetExtensions ?? DEFAULT_ASSET_EXTENSIONS).map(e =>
      e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`
    ),
    concurrency: options.concurrency ?? user.concurrency ?? availableParallelism(),
    readConcurrency: user.readConcurrency ?? 64,
    onValidationError: options.onValidationError ?? user.onValidationError ?? 'fail',
    onUnknownField: user.onUnknownField ?? 'warn'
  }
}

/**
 * Reject configs that would emit broken output.
 *
 * content-collections derives export names via `pluralize` with no collision
 * check, so collections named `post` and `posts` both emit `allPosts` — a
 * duplicate import and a SyntaxError — while the build reports success. Here
 * that is a config error before anything is written.
 */
function validateCollections(
  input: Record<string, CollectionDefinition>,
  base: string
): Record<string, ResolvedCollection> {
  const out: Record<string, ResolvedCollection> = {}
  const typeNames = new Map<string, string>()
  const names = new Map<string, string>()

  for (const [key, def] of Object.entries(input)) {
    if (!def || typeof def !== 'object') {
      throw new ConfigError(`Collection "${key}" is not a collection definition`)
    }
    const name = def.name ?? key
    if (!isIdentifier(name)) {
      throw new ConfigError(
        `Collection name "${name}" is not a valid JavaScript identifier`,
        'Collection names become export names, so they must match /^[A-Za-z_$][A-Za-z0-9_$]*$/.'
      )
    }
    if (RESERVED.has(name)) {
      throw new ConfigError(
        `Collection name "${name}" is reserved`,
        'It becomes an export name in the generated module, which would not parse.'
      )
    }
    const duplicate = names.get(name)
    if (duplicate !== undefined) {
      throw new ConfigError(
        `Two collections are both named "${name}" (config keys "${duplicate}" and "${key}")`,
        'Collection names become export names, so they must be unique.'
      )
    }
    names.set(name, key)
    if (def.loader) {
      if (def.directory ?? def.include) {
        throw new ConfigError(
          `Collection "${name}" sets both \`loader\` and \`directory\`/\`include\``,
          'A collection has one source. Remove the file options, or remove the loader.'
        )
      }
    } else {
      if (!def.directory) {
        throw new ConfigError(
          `Collection "${name}" is missing \`directory\``,
          'File-based collections need `directory` and `include`; other sources need a `loader`.'
        )
      }
      if (!def.include) {
        throw new ConfigError(`Collection "${name}" is missing \`include\``)
      }
    }
    // arktype's Type is CALLABLE, so a `typeof === "object"` check rejects a
    // perfectly valid Standard Schema implementation. Test for the interface,
    // not for a representation.
    if (!isStandardSchema(def.schema)) {
      throw new ConfigError(
        `Collection "${name}" has no Standard Schema in \`schema\``,
        'Pass a zod, valibot, arktype or effect schema — anything implementing Standard Schema.'
      )
    }

    const typeName = def.typeName ?? pascalSingular(name)
    const clash = typeNames.get(typeName)
    if (clash !== undefined) {
      throw new ConfigError(
        `Collections "${clash}" and "${name}" both produce the type name "${typeName}"`,
        `Set an explicit \`typeName\` on one of them.`
      )
    }
    typeNames.set(typeName, name)

    const heavy = def.heavy ?? DEFAULT_HEAVY
    if (def.index) {
      const conflict = def.index.filter(f => heavy.includes(f))
      if (conflict.length > 0) {
        throw new ConfigError(
          `Collection "${name}" lists ${conflict.map(c => `"${c}"`).join(', ')} in both \`index\` and \`heavy\``,
          'A heavy field is never carried in the index, so listing it there has no effect.'
        )
      }
    }

    out[name] = {
      ...def,
      name,
      typeName,
      ...(def.directory === undefined ? {} : { directory: resolve(base, def.directory) }),
      heavy
    }
  }

  if (Object.keys(out).length === 0) {
    throw new ConfigError('No collections defined', 'Add at least one collection.')
  }
  return out
}

/**
 * A Standard Schema is anything carrying a `~standard` property with a
 * `validate` function — object or function, since vendors differ.
 */
function isStandardSchema(value: unknown): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  const standard = (value as { '~standard'?: { validate?: unknown } })['~standard']
  return typeof standard?.validate === 'function'
}

/**
 * Words that are valid identifiers by regex but cannot be used as export
 * names, or would shadow something in the generated module.
 */
const RESERVED = new Set([
  'default',
  'import',
  'export',
  'const',
  'let',
  'var',
  'function',
  'class',
  'return',
  'new',
  'typeof',
  'void',
  'null',
  'true',
  'false',
  'await',
  'collection'
])

/** `posts` -> `Post`, `authors` -> `Author`, `news` -> `News`. */
function pascalSingular(name: string): string {
  const singular = singularize(name)
  return singular.charAt(0).toUpperCase() + singular.slice(1)
}

function singularize(word: string): string {
  if (/(ss|us|is|s's)$/i.test(word)) return word
  if (/ies$/i.test(word)) return word.slice(0, -3) + 'y'
  if (/(ch|sh|x|z|s)es$/i.test(word)) return word.slice(0, -2)
  if (/s$/i.test(word)) return word.slice(0, -1)
  return word
}
