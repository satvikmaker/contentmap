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
/** Descriptor exhaustion. Transient on every platform. */
const TRANSIENT = new Set(['EMFILE', 'ENFILE'])

/**
 * Sharing violations, which only Windows produces.
 *
 * Windows refuses to rename or replace a file while another handle holds it,
 * and in watch mode there is always another handle: the watcher itself, plus
 * whatever the machine indexes with. The rename in an atomic write is the
 * exposed step, and it surfaces as EPERM or EBUSY rather than as anything
 * descriptor-shaped. It took out a CI rebuild that started and never finished.
 *
 * Deliberately NOT retried on POSIX, where these codes mean the permission is
 * genuinely denied and will stay denied. Retrying there would spend the full
 * backoff before reporting a read failure — the diagnostic this project treats
 * as a headline feature — and turn an instant, correct error into a slow one.
 */
const SHARING_VIOLATION = new Set(['EPERM', 'EBUSY', 'EACCES'])
const isWindows = process.platform === 'win32'

export async function withFdRetry<T>(operation: () => Promise<T>, attempts = 8): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const code: unknown = (error as { code?: unknown }).code
      const retryable =
        typeof code === 'string' &&
        (TRANSIENT.has(code) || (isWindows && SHARING_VIOLATION.has(code)))
      if (!retryable || attempt >= attempts) throw error
      await new Promise(resolve => setTimeout(resolve, 2 ** attempt))
    }
  }
}
