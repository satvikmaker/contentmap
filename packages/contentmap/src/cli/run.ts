import { parseArgs } from 'node:util'
import { createBuilder } from '../builder.ts'
import { ConfigError } from '../config/resolve.ts'
import { codeFrame, DiagnosticBag, renderDiagnostics } from '../diagnostics/index.ts'
import { cleanOutput, exists } from '../write/emit.ts'
import { resolveConfig } from '../config/resolve.ts'
import { bold, cyan, dim, green, red, yellow } from '../utils/ansi.ts'
import { readFile } from 'node:fs/promises'
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
  init               Scaffold a config file.

${bold('Options')}
  -c, --config <path>            Config file path
  -o, --outdir <path>            Output directory
      --clean                    Remove output before building
      --concurrency <n>          Max parallel transforms
      --format <modules|bundle|both>
      --on-validation-error <fail|warn|skip|ignore>
      --json                     Machine-readable diagnostics
  -s, --silent                   Errors only
  -v, --verbose                  Per-phase timing
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
        clean: { type: 'boolean' },
        concurrency: { type: 'string' },
        format: { type: 'string' },
        'on-validation-error': { type: 'string' },
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
    process.stdout.write('0.0.0\n')
    return 0
  }
  const command = positionals[0] ?? (values.help === true ? 'help' : undefined)
  if (command === undefined || command === 'help' || values.help === true) {
    process.stdout.write(`${HELP}\n`)
    return command === undefined ? 1 : 0
  }

  const options: BuilderOptions = {
    ...(values.config === undefined ? {} : { config: values.config }),
    ...(values.outdir === undefined ? {} : { outDir: values.outdir }),
    ...(values.clean === undefined ? {} : { clean: values.clean }),
    ...(values.concurrency === undefined ? {} : { concurrency: Number(values.concurrency) }),
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
      case 'dev': {
        // Honest placeholder: watch mode is M7. Build once so the command is
        // not simply a dead end, and say plainly what is missing.
        process.stderr.write(
          `${yellow('!')} watch mode arrives in M7 — building once instead.\n`
        )
        return await build(options, values)
      }
      case 'init':
        process.stderr.write(`${yellow('!')} \`init\` arrives in M9.\n`)
        return 1
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
  const match = LOCATION_RE.exec(message) ?? (ours ? null : LOCATION_RE.exec(err?.stack ?? ''))
  const file = err.file ?? (match?.[1] === undefined ? undefined : stripScheme(match[1]))
  const line = match?.[2] === undefined ? undefined : Number(match[2])
  const column = match?.[3] === undefined ? undefined : Number(match[3])

  if (file) {
    const where = line === undefined ? file : `${file}:${line}${column ? `:${column}` : ''}`
    process.stderr.write(`  ${cyan(where)}\n`)
    if (line !== undefined) {
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

async function clean(options: BuilderOptions): Promise<number> {
  const config = await resolveConfig(options)
  const had = await exists(config.output.dir)
  await cleanOutput(config)
  process.stdout.write(
    had ? `${green('✔')} removed ${cyan(config.output.dir)}\n` : `${dim('nothing to clean')}\n`
  )
  return 0
}
