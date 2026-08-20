/**
 * Retry a filesystem operation through descriptor exhaustion.
 *
 * Bounded concurrency prevents the pathological case, but a constrained
 * container can still hit EMFILE/ENFILE because stdio, the module loader and
 * the watcher all hold descriptors. These errors are transient by construction
 * — peers release descriptors as they finish — so a short backoff turns a hard
 * failure into a slightly slower success. Every other error rethrows at once.
 *
 * This wraps writes and directory reads as well as source reads: an fd-starved
 * build that crashed while *emitting* would be just as broken as one that
 * crashed while reading.
 */
const TRANSIENT = new Set([
  'EMFILE',
  'ENFILE',
  // Windows refuses to rename or replace a file while another handle holds it,
  // and during watch mode there is always another handle: the watcher itself,
  // plus whatever indexer or scanner the machine runs. The rename in an atomic
  // write is the exposed step, and it fails as EPERM or EBUSY rather than as
  // anything descriptor-shaped. Transient in exactly the same way — the other
  // handle closes — and it took out a CI rebuild that started and never
  // finished.
  'EPERM',
  'EBUSY',
  'EACCES'
])

export async function withFdRetry<T>(operation: () => Promise<T>, attempts = 8): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const code: unknown = (error as { code?: unknown }).code
      if (typeof code !== 'string' || !TRANSIENT.has(code) || attempt >= attempts) throw error
      await new Promise(resolve => setTimeout(resolve, 2 ** attempt))
    }
  }
}
