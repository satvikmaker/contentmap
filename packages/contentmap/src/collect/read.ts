import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { glob } from 'tinyglobby'
import type { CollectionDefinition, DocumentMeta, ResolvedConfig } from '../types.ts'
import { digest } from '../utils/digest.ts'
import { withFdRetry } from '../utils/fd.ts'
import { mapLimit } from '../utils/limit.ts'
import { idFromPath, relPosix, toPosix } from '../utils/paths.ts'

/** Measured optimum on a 10k-file corpus; 28% faster than unbounded. */
export const READ_CONCURRENCY = 64

export interface SourceFile {
  absolutePath: string
  relativePath: string
  extension: string
  content: string
  digest: string
  mtimeMs: number
  size: number
}

export interface ReadFailure {
  absolutePath: string
  relativePath: string
  error: Error
}

export interface CollectResult {
  files: SourceFile[]
  failures: ReadFailure[]
  /** Files skipped because their mtime and digest were unchanged. */
  unchanged: string[]
}

export interface PreviousState {
  mtimeMs: number
  size: number
  digest: string
}

/**
 * Glob, stat-prefilter, then read with bounded concurrency.
 *
 * Read failures are collected and returned rather than thrown, so one
 * unreadable file cannot abort the corpus — but they are returned, never
 * swallowed. content-collections emits its read errors into the void before a
 * consumer can subscribe, which is how an fd-limited build lost 2,758 of 3,000
 * files and still exited 0.
 */
export interface CollectOptions {
  previous?: ReadonlyMap<string, PreviousState>
  /**
   * Paths the watcher reported as changed, relative to the collection.
   *
   * When present, the watcher is authoritative: a file it did not mention has
   * not changed, so its mtime is not worth a syscall. That removes the whole
   * stat pass from an incremental rebuild — around 27ms of a 10,000-file
   * corpus — leaving only the glob and the reads that actually matter.
   */
  changed?: ReadonlySet<string>
}

export async function collectFiles(
  collection: CollectionDefinition,
  config: ResolvedConfig,
  options: CollectOptions = {}
): Promise<CollectResult> {
  const { previous, changed } = options
  // Config resolution guarantees these for file-based collections; a
  // loader-based one never reaches here.
  const directory = collection.directory
  if (directory === undefined || collection.include === undefined) {
    throw new Error(`Collection "${collection.name}" has no file source`)
  }
  const include = Array.isArray(collection.include)
    ? [...collection.include]
    : [collection.include as string]
  const ignore = collection.exclude
    ? Array.isArray(collection.exclude)
      ? [...collection.exclude]
      : [collection.exclude as string]
    : []

  const matches = await glob(include, {
    cwd: directory,
    ignore,
    onlyFiles: true,
    dot: false,
    absolute: false
  })

  // Sorted for reproducible builds. Native fs.glob returns traversal order,
  // which is one of several reasons we use tinyglobby instead.
  matches.sort()

  const files: SourceFile[] = []
  const failures: ReadFailure[] = []
  const unchanged: string[] = []

  // Reads are IO-bound and peak around 64 regardless of core count, so this is
  // deliberately NOT `config.concurrency` (which governs CPU-bound work).
  const readConcurrency = config.readConcurrency ?? READ_CONCURRENCY
  const results = await mapLimit(matches, readConcurrency, async relative => {
    const absolutePath = join(directory, relative)
    const relativePath = toPosix(relative)
    try {
      const prior = previous?.get(relativePath)
      // The watcher observed this file move, so it is authoritative for it.
      const named = changed?.has(relativePath) ?? false

      // Anything the watcher did not name has not changed, so its mtime is not
      // worth a syscall.
      if (changed && prior && !named) {
        return { kind: 'unchanged' as const, relativePath }
      }

      const info = await stat(absolutePath)
      // Cheap prefilter: 27.5ms for 10k files, versus ~516ms to read them.
      //
      // Skipped for a file the watcher named. mtime has millisecond resolution,
      // and two saves inside the same millisecond are perfectly ordinary while
      // editing — trusting mtime over the watcher there silently drops the
      // edit, and the rebuild never happens.
      //
      // Size is compared too, because without a watcher there is nothing else
      // to appeal to and mtime alone will call a same-millisecond rewrite
      // unchanged. It comes free from the stat already made. It narrows the
      // window rather than closing it: an edit that lands in the same
      // millisecond AND keeps the byte count identical still slips through,
      // and only reading every file would catch that — which is the cost this
      // prefilter exists to avoid.
      if (!named && prior && prior.mtimeMs === info.mtimeMs && prior.size === info.size) {
        return { kind: 'unchanged' as const, relativePath }
      }
      const content = await withFdRetry(() => readFile(absolutePath, 'utf8'))
      return {
        kind: 'file' as const,
        file: {
          absolutePath,
          relativePath,
          extension: extname(relative),
          content,
          digest: digest(content),
          mtimeMs: info.mtimeMs,
          size: info.size
        }
      }
    } catch (error) {
      return {
        kind: 'failure' as const,
        failure: { absolutePath, relativePath, error: asError(error) }
      }
    }
  })

  for (const r of results) {
    if (r.kind === 'file') files.push(r.file)
    else if (r.kind === 'failure') failures.push(r.failure)
    else unchanged.push(r.relativePath)
  }

  return { files, failures, unchanged }
}

export function metaFor(file: SourceFile, collectionDirectory: string): DocumentMeta {
  const id = idFromPath(file.relativePath)
  const path = id
  const slug = id.split('/').pop() ?? id
  return {
    id,
    filePath: file.relativePath,
    fileName: basename(file.relativePath),
    directory: relPosix(collectionDirectory, dirname(file.absolutePath)) || '.',
    extension: file.extension,
    path,
    slug,
    digest: file.digest
  }
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}
