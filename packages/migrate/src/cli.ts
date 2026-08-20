#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { access, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { detect } from './detect.ts'
import { emitConfig, renderNotes } from './emit.ts'
import { migrate } from './index.ts'

const HELP = `
contentmap-migrate — turn a contentlayer2, velite or content-collections config into a contentmap one

Usage
  npx @contentmap/migrate [options]

Options
      --root <path>     Project directory (default: cwd)
  -o, --out <path>      Where to write (default: contentmap.config.ts)
      --report <path>   Where to write the notes (default: CONTENTMAP-MIGRATION.md)
      --force           Overwrite an existing config
      --dry-run         Print the result, write nothing
  -h, --help            Show this message
`.trim()

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let values
  try {
    ;({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        root: { type: 'string' },
        out: { type: 'string', short: 'o' },
        report: { type: 'string' },
        force: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' }
      }
    }))
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}\n`)
    return 1
  }

  if (values.help === true) {
    process.stdout.write(`${HELP}\n`)
    return 0
  }

  const root = values.root ?? process.cwd()
  const found = await detect(root)
  if (!found) {
    process.stderr.write(
      'No contentlayer, velite or content-collections config found.\n' +
        'Looked for contentlayer.config.*, velite.config.* and content-collections.* in ' +
        `${root}\n`
    )
    return 1
  }

  const result = migrate(found.source, found.tool, found.path)
  process.stdout.write(
    `Found a ${found.tool} config at ${relative(root, found.path)}\n` +
      `Translated ${result.collections.length} collection(s): ${result.collections.join(', ')}\n\n`
  )

  const report = renderNotes(result.notes)

  if (values['dry-run'] === true) {
    process.stdout.write(`${result.config}\n`)
    process.stdout.write(`${report}\n`)
    return 0
  }

  const outPath = join(root, values.out ?? 'contentmap.config.ts')
  const reportPath = join(root, values.report ?? 'CONTENTMAP-MIGRATION.md')

  if (values.force !== true && (await exists(outPath))) {
    process.stderr.write(
      `${outPath} already exists. Pass --force to replace it, or --dry-run to see the result.\n`
    )
    return 1
  }

  await writeFile(outPath, result.config, 'utf8')
  await writeFile(
    reportPath,
    `# Migrating from ${found.tool}\n\n` +
      `Generated from \`${relative(root, found.path)}\`. ` +
      'Your original config was not modified.\n\n' +
      report,
    'utf8'
  )

  process.stdout.write(`  + ${relative(root, outPath)}\n  + ${relative(root, reportPath)}\n\n`)
  const counts = {
    unsupported: result.notes.filter(n => n.kind === 'unsupported').length,
    manual: result.notes.filter(n => n.kind === 'manual').length,
    review: result.notes.filter(n => n.kind === 'review').length
  }
  if (result.notes.length > 0) {
    process.stdout.write(
      `  ${counts.unsupported} unsupported, ${counts.manual} needing hand-editing, ` +
        `${counts.review} worth reviewing — see ${relative(root, reportPath)}\n\n`
    )
  }
  process.stdout.write(`  Install: npm i ${result.install.join(' ')}\n`)
  process.stdout.write('  Then:    npx contentmap build\n')
  return 0
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

export { emitConfig }

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await run()
}
