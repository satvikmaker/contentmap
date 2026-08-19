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
export async function withFdRetry<T>(operation: () => Promise<T>, attempts = 8): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const code: unknown = (error as { code?: unknown }).code
      if ((code !== 'EMFILE' && code !== 'ENFILE') || attempt >= attempts) throw error
      await new Promise(resolve => setTimeout(resolve, 2 ** attempt))
    }
  }
}
