import { parseArgs } from 'node:util'
import { createBuilder } from '../builder.ts'
import { ConfigError } from '../config/resolve.ts'
import { DiagnosticBag } from '../diagnostics.ts'
import { cleanOutput, exists } from '../write/emit.ts'
import { resolveConfig } from '../config/resolve.ts'
import { bold, cyan, dim, green, red, yellow } from '../utils/ansi.ts'
import type { BuilderOptions, EmitFormat, Severity } from '../types.ts'

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
        return await build({ ...options, outDir: undefined as unknown as string }, values, true)
      case 'clean':
        return await clean(options)
      case 'dev':
        process.stderr.write(`${yellow('!')} \`dev\` arrives in M7. Use \`contentmap build\`.\n`)
        return 1
      case 'init':
        process.stderr.write(`${yellow('!')} \`init\` arrives in M9.\n`)
        return 1
      default:
        process.stderr.write(`${red('✖')} Unknown command "${command}"\n\n${HELP}\n`)
        return 1
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${red('✖')} ${bold(error.message)}\n`)
      if (error.hint) process.stderr.write(`  ${dim(error.hint)}\n`)
      return 1
    }
    const e = error as Error
    process.stderr.write(`${red('✖')} ${e.message}\n`)
    if (values.verbose === true && e.stack) process.stderr.write(dim(`${e.stack}\n`))
    return 1
  }
}

type Values = Record<string, unknown>

async function build(options: BuilderOptions, values: Values, checkOnly = false): Promise<number> {
  const builder = createBuilder(options)
  const silent = values['silent'] === true

  // Slow builds announce themselves; fast ones stay quiet. No spinner, no dep.
  const notice = setTimeout(() => {
    if (!silent && values['json'] !== true) process.stderr.write(dim('building…\n'))
  }, 1000)

  const result = await builder.build()
  clearTimeout(notice)

  if (values['json'] === true) {
    process.stdout.write(`${JSON.stringify({ ...result, diagnostics: result.diagnostics }, null, 2)}\n`)
    return result.errors > 0 ? 1 : 0
  }

  if (result.diagnostics.length > 0) {
    const bag = new DiagnosticBag()
    for (const d of result.diagnostics) bag.add(d)
    process.stderr.write(`${bag.format(result.documents)}\n`)
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

async function clean(options: BuilderOptions): Promise<number> {
  const config = await resolveConfig(options)
  const had = await exists(config.output.dir)
  await cleanOutput(config)
  process.stdout.write(
    had ? `${green('✔')} removed ${cyan(config.output.dir)}\n` : `${dim('nothing to clean')}\n`
  )
  return 0
}
