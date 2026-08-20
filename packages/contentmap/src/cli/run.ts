import { parseArgs } from 'node:util'
import { createBuilder } from '../builder.ts'
import { ConfigError } from '../config/resolve.ts'
import { codeFrame, DiagnosticBag, renderDiagnostics } from '../diagnostics/index.ts'
import { init } from './init.ts'
import { cleanOutput, exists } from '../write/emit.ts'
import { resolveConfig } from '../config/resolve.ts'
import { bold, cyan, dim, green, red, yellow } from '../utils/ansi.ts'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { BuildResult, BuilderOptions, EmitFormat, Severity } from '../types.ts'

const HELP = `
${bold('contentmap')} — the type-safe content layer for every framework

${bold('Usage')}
  contentmap <command> [options]

${bold('Commands')}
  build              Build once. Non-zero exit on error.
  dev                Build and watch.
  check              Validate only; emit nothing. For CI.
  clean              Remove generated output.
  init               Scaffold a config, sample content and tsconfig path.

${bold('Options')}
  -c, --config <path>            Config file path
  -o, --outdir <path>            Output directory
      --cache-dir <path>         Incremental cache location (default <outdir>/.cache)
      --clean                    Remove output, keeping the cache
      --concurrency <n>          Max parallel transforms
      --format <modules|bundle|both>
      --on-validation-error <fail|warn|skip|ignore>
      --frozen                   Fail rather than fetch remote content (CI)
      --debounce <ms>            Coalesce watch events (dev, default 50)
      --force                    Overwrite existing files (init)
      --json                     Machine-readable diagnostics
  -s, --silent                   Errors only
  -v, --verbose                  Per-phase timing, and stacks on failure
  -h, --help                     Show this message
      --version                  Show version
`.trim()

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string', short: 'c' },
        outdir: { type: 'string', short: 'o' },
        'cache-dir': { type: 'string' },
        clean: { type: 'boolean' },
        concurrency: { type: 'string' },
        format: { type: 'string' },
        'on-validation-error': { type: 'string' },
        frozen: { type: 'boolean' },
        debounce: { type: 'string' },
        force: { type: 'boolean' },
        json: { type: 'boolean' },
        silent: { type: 'boolean', short: 's' },
        verbose: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' }
      }
    })
  } catch (error) {
    process.stderr.write(`${red('✖')} ${(error as Error).message}\n\n${HELP}\n`)
    return 1
  }

  const { values, positionals } = parsed
  if (values.version === true) {
    process.stdout.write(`${await version()}\n`)
    return 0
  }
  const command = positionals[0] ?? (values.help === true ? 'help' : undefined)
  if (command === undefined || command === 'help' || values.help === true) {
    process.stdout.write(`${HELP}\n`)
    return command === undefined ? 1 : 0
  }

  const concurrency = numeric(values.concurrency, 'concurrency')
  const debounce = numeric(values.debounce, 'debounce')
  if (concurrency instanceof Error || debounce instanceof Error) {
    const bad = concurrency instanceof Error ? concurrency : (debounce as Error)
    process.stderr.write(`${red('✖')} ${bad.message}\n`)
    return 1
  }

  const options: BuilderOptions = {
    ...(values.config === undefined ? {} : { config: values.config }),
    ...(values.outdir === undefined ? {} : { outDir: values.outdir }),
    ...(values['cache-dir'] === undefined ? {} : { cacheDir: values['cache-dir'] }),
    ...(values.clean === undefined ? {} : { clean: values.clean }),
    ...(values.frozen === undefined ? {} : { frozen: values.frozen }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(values.format === undefined ? {} : { format: values.format as EmitFormat }),
    ...(values['on-validation-error'] === undefined
      ? {}
      : { onValidationError: values['on-validation-error'] as Severity })
  }

  try {
    switch (command) {
      case 'build':
        return await build(options, values)
      case 'check':
        return await build({ ...options, dryRun: true }, values, true)
      case 'clean':
        return await clean(options)
      case 'dev':
        return await dev(options, values, debounce)
      case 'init':
        return await scaffold(options, values)
      default:
        process.stderr.write(`${red('✖')} Unknown command "${command}"\n\n${HELP}\n`)
        return 1
    }
  } catch (error) {
    await reportFatal(error, values.verbose === true)
    return 1
  }
}

type Values = Record<string, unknown>

/**
 * `--concurrency abc` must not reach the builder as NaN, where it silently
 * becomes an unbounded fan-out and blows the file-descriptor limit.
 */
function numeric(raw: unknown, flag: string): number | undefined | Error {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    return new Error(`--${flag} expects a non-negative number, received "${String(raw)}"`)
  }
  return n
}

/**
 * The version people report bugs against has to be the version they installed.
 * Read from the manifest beside the bundle rather than a literal that goes
 * stale on the first release.
 */
async function version(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let up = 0; up < 5; up++) {
    try {
      const pkg: unknown = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      const { name, version } = pkg as { name?: unknown; version?: unknown }
      // Stop at our own manifest. Walking blindly would happily report the
      // version of whatever application happens to sit above us.
      if (name === 'contentmap' && typeof version === 'string') return version
    } catch {
      // no manifest at this level, or unreadable — keep walking
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return 'unknown'
}

/**
 * Where the time went. Phases overlap — sixty-four files parse concurrently —
 * so these are cumulative and overshoot the total. Printing a percentage of
 * wall clock would imply a partition that does not exist, so print the raw
 * milliseconds and say what they are.
 */
function reportPhases(phases: Readonly<Record<string, number>>, totalMs: number): void {
  const rows = Object.entries(phases)
  if (rows.length === 0) return
  rows.sort((a, b) => b[1] - a[1])
  const width = Math.max(...rows.map(([name]) => name.length))
  process.stderr.write(`\n  ${dim('phase'.padEnd(width + 2))}${dim('cumulative')}\n`)
  for (const [name, ms] of rows) {
    // "<1ms" rather than "0ms" or omission: a stage that ran and cost nothing
    // is a different fact from a stage that never ran at all.
    const shown = ms < 1 ? '<1ms' : `${Math.round(ms)}ms`
    process.stderr.write(`  ${name.padEnd(width + 2)}${cyan(shown)}\n`)
  }
  process.stderr.write(
    `  ${dim(`wall clock ${Math.round(totalMs)}ms — phases run concurrently and do not sum to it`)}\n`
  )
}

/** `file.ts:12:3` appearing anywhere in a message or stack. */
const LOCATION_RE = /([^\s():]+\.(?:[cm]?[tj]s|json|ya?ml)):(\d+)(?::(\d+))?/

/**
 * Present a fatal error the way a compiler would: what failed, where, and the
 * offending line.
 *
 * A config with a syntax error is the most common first-run failure, and
 * content-collections surfaces it as an unhandled rejection with a twelve-frame
 * stack through its CLI framework. Anything we cannot locate still prints its
 * message rather than a stack.
 */
async function reportFatal(error: unknown, verbose: boolean): Promise<void> {
  const err = error as Error & { hint?: string; file?: string }
  const message = err?.message ?? String(error)
  // Any error contentmap raises itself knows its own context. Mining a stack
  // for these prints our dist bundle with a code frame at the user, which is
  // never what they need to see.
  const OURS = new Set([
    'ConfigError',
    'ReferenceCycleError',
    'SelfReferenceError',
    'UnknownCollectionError',
    'MissingReferenceError',
    'SerializeError',
    'MissingRendererError',
    'MissingImageProcessorError',
    'OutsideRootError'
  ])
  const ours = err instanceof ConfigError || OURS.has(err?.name)

  process.stderr.write(`${red('✖')} ${bold(message.split('\n')[0] ?? message)}\n`)

  // Only mine a stack for a location when the error came from user code (a
  // config that failed to parse). For our own errors the deepest frame is
  // contentmap's dist bundle, and printing that shows the user our internals
  // instead of their problem.
  const match = LOCATION_RE.exec(message) ?? (ours ? null : firstUserFrame(err?.stack ?? ''))
  const file = err.file ?? (match?.[1] === undefined ? undefined : stripScheme(match[1]))
  const line = match?.[2] === undefined ? undefined : Number(match[2])
  const column = match?.[3] === undefined ? undefined : Number(match[3])

  if (file) {
    const where = line === undefined ? file : `${file}:${line}${column ? `:${column}` : ''}`
    process.stderr.write(`  ${cyan(where)}\n`)
    if (line !== undefined && !file.includes('node_modules')) {
      try {
        const source = await readFile(file, 'utf8')
        const frame = codeFrame(source, { line, ...(column === undefined ? {} : { column }) })
        for (const l of frame.split('\n')) process.stderr.write(`  ${dim(l)}\n`)
      } catch {
        // unreadable or synthetic — the location alone still helps
      }
    }
  }

  if (err?.hint) process.stderr.write(`  ${dim(err.hint)}\n`)
  if (verbose && err?.stack) process.stderr.write(dim(`${err.stack}\n`))
}

/**
 * The deepest stack frame is usually inside a dependency. A missing module
 * throws from jiti's own bundle, and framing that prints a 200-character
 * minified line with a caret under it — noise wearing the costume of a
 * diagnostic. Walk down to the first frame the user could actually edit.
 */
function firstUserFrame(stack: string): RegExpExecArray | null {
  let fallback: RegExpExecArray | null = null
  for (const line of stack.split('\n')) {
    const m = LOCATION_RE.exec(line)
    if (!m) continue
    fallback ??= m
    if (!m[1]?.includes('node_modules')) return m
  }
  // Every frame was vendor code: keep the location, and let the caller skip
  // the frame rather than drawing one from a bundle.
  return fallback
}

/** `file:///a/b.ts` and `///a/b.ts` both denote `/a/b.ts`. */
function stripScheme(path: string): string {
  return path.replace(/^file:\/\//, '').replace(/^\/{2,}/, '/')
}

async function build(options: BuilderOptions, values: Values, checkOnly = false): Promise<number> {
  const builder = createBuilder(options)
  const silent = values['silent'] === true

  // Slow builds announce themselves; fast ones stay quiet. No spinner, no dep.
  const notice = setTimeout(() => {
    if (!silent && values['json'] !== true) process.stderr.write(dim('building…\n'))
  }, 1000)

  // finally, not a trailing clearTimeout: a build that throws would otherwise
  // leave the timer armed and print "building…" *after* the error.
  let result
  try {
    result = await builder.build()
  } finally {
    clearTimeout(notice)
  }

  if (values['json'] === true) {
    process.stdout.write(`${JSON.stringify(toJson(result, checkOnly), null, 2)}\n`)
    return result.errors > 0 ? 1 : 0
  }

  if (result.diagnostics.length > 0) {
    const bag = new DiagnosticBag()
    for (const d of result.diagnostics) bag.add(d)
    process.stderr.write(`${renderDiagnostics(bag, { total: result.scanned })}\n`)
  }

  if (result.errors > 0) {
    process.stderr.write(
      `${red('✖')} ${bold('Build failed')} — ${result.errors} error${result.errors === 1 ? '' : 's'}. ` +
        `${dim('Run with --on-validation-error=warn to build anyway.')}\n`
    )
    return 1
  }

  if (values['verbose'] === true && !silent) reportPhases(result.phases, result.durationMs)

  if (!silent) {
    const ms = Math.round(result.durationMs)
    const what = checkOnly ? 'checked' : 'built'
    process.stdout.write(
      `${green('✔')} ${what} ${cyan(String(result.documents))} document${result.documents === 1 ? '' : 's'} ` +
        `in ${cyan(String(result.collections))} collection${result.collections === 1 ? '' : 's'} ` +
        dim(`(${ms}ms)`) +
        '\n'
    )
  }
  return 0
}

/**
 * Stable machine-readable output.
 *
 * Explicitly shaped rather than spreading BuildResult, so adding an internal
 * field cannot silently change the contract. `frame` is dropped: it is an ASCII
 * drawing for humans, and embedding it made messages multi-line.
 */
function toJson(result: BuildResult, checkOnly: boolean): unknown {
  return {
    version: 1,
    ok: result.errors === 0,
    command: checkOnly ? 'check' : 'build',
    collections: result.collections,
    documents: result.documents,
    scanned: result.scanned,
    errors: result.errors,
    warnings: result.warnings,
    cacheHits: result.cacheHits,
    durationMs: Math.round(result.durationMs),
    // Additive to the v1 contract. Rounded, because sub-millisecond noise in a
    // CI diff is not a signal anyone can act on.
    phases: Object.fromEntries(
      Object.entries(result.phases).map(([name, ms]) => [name, Math.round(ms)])
    ),
    diagnostics: result.diagnostics.map(d => ({
      code: d.code,
      severity: d.severity,
      message: d.message,
      ...(d.file === undefined ? {} : { file: d.file }),
      ...(d.line === undefined ? {} : { line: d.line }),
      ...(d.column === undefined ? {} : { column: d.column }),
      ...(d.field === undefined ? {} : { field: d.field }),
      ...(d.hint === undefined ? {} : { hint: d.hint }),
      ...(d.collection === undefined ? {} : { collection: d.collection }),
      ...(d.documentId === undefined ? {} : { documentId: d.documentId })
    }))
  }
}

async function dev(
  options: BuilderOptions,
  values: Values,
  debounce: number | undefined
): Promise<number> {
  const builder = createBuilder(options)
  const silent = values['silent'] === true

  builder.on(event => {
    if (silent) return
    if (event.type === 'log' && (event.level !== 'debug' || values['verbose'] === true)) {
      process.stderr.write(`${dim(event.message)}\n`)
    }
    if (event.type === 'watch:change') {
      process.stderr.write(`${dim(`changed ${event.path}`)}\n`)
    }
  })

  const report = (result: Awaited<ReturnType<typeof builder.build>>): void => {
    if (result.diagnostics.length > 0) {
      const bag = new DiagnosticBag()
      for (const d of result.diagnostics) bag.add(d)
      process.stderr.write(`${renderDiagnostics(bag, { total: result.scanned })}\n`)
    }
    if (silent) return
    const ms = Math.round(result.durationMs)
    const mark = result.errors > 0 ? red('✖') : green('✔')
    process.stderr.write(
      `${mark} ${result.documents} document${result.documents === 1 ? '' : 's'} ${dim(`(${ms}ms)`)}\n`
    )
    if (values['verbose'] === true) reportPhases(result.phases, result.durationMs)
  }

  // Subscribed before the first build, not after: a late subscriber is replayed
  // the buffered history, which would report that build a second time.
  builder.on(event => {
    if (event.type === 'build:end') report(event.result)
  })

  await builder.build()
  const handle = await builder.watch(debounce === undefined ? {} : { debounce })
  if (!silent) {
    process.stderr.write(`${cyan('watching')} ${dim(`${handle.paths.length} path(s)`)}\n`)
  }

  // Run until interrupted. A non-zero exit here would be wrong: the first
  // build failing is a normal part of editing.
  await new Promise<void>(resolve => {
    const stop = () => {
      void builder.close().then(resolve)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}

async function scaffold(options: BuilderOptions, values: Values): Promise<number> {
  const root = options.root ?? process.cwd()
  const result = await init({ root, force: values['force'] === true })

  process.stdout.write(`${green('✔')} ${bold('contentmap')} ${dim(`(${result.detected})`)}\n`)
  for (const file of result.created) process.stdout.write(`  ${green('+')} ${file}\n`)
  for (const file of result.updated) process.stdout.write(`  ${cyan('~')} ${file}\n`)
  for (const file of result.skipped) {
    process.stdout.write(
      `  ${dim('=')} ${dim(`${file} (exists, left alone — pass --force to replace)`)}\n`
    )
  }
  process.stdout.write('\n')
  for (const note of result.notes) process.stdout.write(`  ${dim(note)}\n`)

  if (result.install.length > 0) {
    process.stdout.write(`\n  Install: ${cyan(`npm i ${result.install.join(' ')}`)}\n`)
  }
  process.stdout.write(`  Then:    ${cyan('npx contentmap build')}\n`)
  return 0
}

async function clean(options: BuilderOptions): Promise<number> {
  const config = await resolveConfig(options)
  const had = await exists(config.output.dir)
  await cleanOutput(config)
  process.stdout.write(
    had ? `${green('✔')} removed ${cyan(config.output.dir)}\n` : `${dim('nothing to clean')}\n`
  )
  return 0
}
