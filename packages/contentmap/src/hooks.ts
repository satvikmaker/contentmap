import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { DiagnosticBag } from './diagnostics/index.ts'
import type { AfterBuildContext, AnyDocument, Logger, ResolvedConfig } from './types.ts'
import { withFdRetry } from './utils/fd.ts'

export interface AfterBuildInput {
  config: ResolvedConfig
  /** A collection's documents, as the generated modules hold them. */
  documents(collection: string): AnyDocument[]
  /** The collection a reference names; throws for one that does not exist. */
  nameOf(ref: unknown): string
  logger: Logger
  /** Absolute paths hooks have written, so the watcher can ignore them. */
  written: Set<string>
  diagnostics: DiagnosticBag
}

/**
 * Run every `afterBuild` hook, in order.
 *
 * A failure becomes an error diagnostic rather than an exception: the build's
 * output is already on disk, and the report should say which hook failed and
 * why, the way a transform failure names its document. One failing does not
 * stop the next — hooks are usually independent (a feed, a sitemap, a search
 * index), and one being broken does not make the others wrong.
 */
export async function runAfterBuild(input: AfterBuildInput): Promise<void> {
  const { config, diagnostics } = input
  const context: AfterBuildContext = {
    collections: Object.keys(config.collections),
    root: config.root,
    logger: input.logger,
    documents: (ref => input.documents(input.nameOf(ref))) as AfterBuildContext['documents'],
    writeFile: (path, content) => writeProjectFile(config.root, path, content, input.written)
  }

  const hooks = config.afterBuild
  for (const [index, hook] of hooks.entries()) {
    try {
      await hook(context)
    } catch (error) {
      const err = error as (Error & { hint?: string }) | undefined
      diagnostics.add({
        code: 'CM_AFTER_BUILD',
        severity: 'error',
        message: `afterBuild${hooks.length > 1 ? ` #${index + 1}` : ''} failed: ${err?.message ?? String(error)}`,
        hint:
          err?.hint ??
          'Every document was written; only what this hook produces is missing or out of date.'
      })
    }
  }
}

let tmpCounter = 0

/**
 * `ctx.writeFile`: inside the project, skipped when unchanged, atomic.
 *
 * The skip is what makes a hook safe to run on every rebuild: rewriting an
 * identical file bumps its mtime, and a dev server watching it reloads the
 * page for nothing.
 */
export async function writeProjectFile(
  root: string,
  path: string,
  content: string | Uint8Array,
  written: Set<string>
): Promise<string> {
  const target = resolve(root, path)
  const inside = relative(root, target)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(
      `writeFile only writes inside the project: "${path}" resolves to ${target}, outside ${root}`
    )
  }
  // Recorded before the write, so the watcher already ignores the event it causes.
  written.add(target)
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  try {
    if ((await readFile(target)).equals(bytes)) return target
  } catch {
    // Missing or unreadable: write it.
  }
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${tmpCounter++}.tmp`
  await withFdRetry(() => writeFile(tmp, bytes))
  await withFdRetry(() => rename(tmp, target))
  return target
}
