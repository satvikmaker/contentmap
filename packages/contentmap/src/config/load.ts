import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cacheKey } from '../utils/digest.ts'

/**
 * Error codes Node raises when it cannot handle a TypeScript file itself.
 *
 * `e instanceof SyntaxError` is load-bearing and easy to omit: when the nearest
 * package.json lacks `"type":"module"`, Node treats a .ts file as CJS and
 * throws a bare SyntaxError with NO `.code`. Most published examples check
 * codes only, so their fallback never fires and the build simply crashes.
 */
const RECOVERABLE = new Set([
  'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',
  'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_REQUIRE_ESM',
  'ERR_MODULE_NOT_FOUND'
])

function isRecoverable(e: unknown): boolean {
  if (e instanceof SyntaxError) return true
  const code: unknown = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' && RECOVERABLE.has(code)
}

export interface LoadedModule {
  value: unknown
  /** Files whose change should trigger a config reload. */
  deps: string[]
  digest: string
  loader: 'native' | 'jiti'
}

/**
 * Import a TS/JS module, preferring Node's own type stripping and falling back
 * to jiti. jiti's 1.5MB babel blob is lazily loaded, so the happy path never
 * touches it. We deliberately avoid esbuild here: velite and content-collections
 * both pay an 11MB dependency plus a per-platform binary — which breaks in
 * multi-arch Docker and read-only node_modules — purely to get a dependency
 * graph we can obtain by scanning relative imports.
 */
/**
 * A dynamic import the bundler cannot see, used only to escape one specific
 * failure.
 *
 * Vite's SSR transform rewrites a plain `import()` into its module-runner
 * shim. That is usually harmless and even useful, but Astro syncs content
 * after tearing the runner down, so resolving the user's config through it
 * fails with "Vite module runner has been closed". The condition needs
 * contentmap to be processed rather than externalised — a linked workspace
 * package, or an explicit `ssr.noExternal`.
 *
 * A dynamic import inside `new Function` is opaque to static analysis, so no
 * bundler touches it. It is not the default path: code compiled this way runs
 * in the realm's own scope, and a vm context with no `importModuleDynamically`
 * hook rejects every dynamic import in it. Vitest runs modules exactly that
 * way, so making this the default traded an Astro bug for a broken test suite.
 * Build-time only, and absent from the runtime package that ships to clients —
 * that one contains no eval at all.
 */
const compiledImport: ((specifier: string) => Promise<unknown>) | undefined = (() => {
  try {
    return new Function('u', 'return import(u)') as (s: string) => Promise<unknown>
  } catch {
    return undefined // a CSP forbidding `new Function`
  }
})()

/** The bundler's module graph is gone, not the user's config being wrong. */
function isDeadModuleRunner(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && message.includes('module runner has been closed')
}

export async function loadModule(path: string): Promise<LoadedModule> {
  const abs = isAbsolute(path) ? path : resolve(path)
  const source = await readFile(abs, 'utf8')
  const deps = await scanDeps(abs, source)
  const digest = cacheKey(source, ...(await Promise.all(deps.map(readOrEmpty))))

  // The digest, not Date.now() and not mtimeMs. Date.now() leaks a module into
  // Node's ESM registry on every reload and grows memory monotonically. mtimeMs
  // looks like the careful answer and is not: two writes inside the same
  // millisecond are ordinary while editing, and on a fast machine they produce
  // the same URL, so the stale module is served and the config change is
  // simply invisible. That failed two config-reload tests on CI and passed
  // locally. Keying on content gets both properties — an edit always busts, and
  // identical content always reuses the same module.
  const url = `${pathToFileURL(abs).href}?t=${digest}`

  try {
    const mod: unknown = await import(url)
    return { value: unwrap(mod), deps, digest, loader: 'native' }
  } catch (error) {
    // Retry outside the bundler's graph before deciding anything is wrong with
    // the config. Only for a runner that has already shut down: any other
    // failure is the real answer and retrying it just produces a second,
    // more confusing error.
    if (isDeadModuleRunner(error) && compiledImport !== undefined) {
      const mod: unknown = await compiledImport(url)
      return { value: unwrap(mod), deps, digest, loader: 'native' }
    }
    if (!isRecoverable(error)) throw error
    const { createJiti } = await import('jiti')
    const jiti = createJiti(import.meta.url, { tsconfigPaths: true, interopDefault: true })
    const mod: unknown = await jiti.import(abs, {})
    return { value: unwrap(mod), deps, digest, loader: 'jiti' }
  }
}

function unwrap(mod: unknown): unknown {
  if (mod && typeof mod === 'object' && 'default' in mod) {
    return (mod as { default: unknown }).default
  }
  return mod
}

async function readOrEmpty(p: string): Promise<string> {
  try {
    return await readFile(p, 'utf8')
  } catch {
    return ''
  }
}

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\b[^'"]*?from\s*['"](\.[^'"]+)['"]/g
const BARE_IMPORT_RE = /(?:^|[\s;])import\s*['"](\.[^'"]+)['"]/g
const REQUIRE_RE = /\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g

const EXTENSIONS = ['', '.ts', '.mts', '.js', '.mjs', '/index.ts', '/index.js']

/**
 * Collect local (relative) imports one level deep, so the watcher knows which
 * files should trigger a config reload. Regex rather than a real parser: this
 * is exactly what Tailwind v4 does, and it avoids an esbuild dependency whose
 * only purpose would be `metafile.inputs`.
 */
async function scanDeps(entry: string, source: string): Promise<string[]> {
  const found = new Set<string>()
  const base = dirname(entry)
  for (const re of [IMPORT_RE, BARE_IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) {
      const spec = m[1]
      if (spec) found.add(spec)
    }
  }
  const resolved: string[] = []
  for (const spec of found) {
    const withoutExt = spec.replace(/\.(ts|mts|js|mjs)$/, '')
    for (const ext of EXTENSIONS) {
      const candidate = resolve(base, withoutExt + ext)
      try {
        const s = await stat(candidate)
        if (s.isFile()) {
          resolved.push(candidate)
          break
        }
      } catch {
        // try the next extension
      }
    }
  }
  return resolved.sort()
}
