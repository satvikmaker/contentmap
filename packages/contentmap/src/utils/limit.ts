/**
 * Run `fn` over `items` with at most `n` in flight.
 *
 * Every batch filesystem operation in contentmap goes through this. Unbounded
 * `Promise.all` over file reads is the direct cause of velite's open EMFILE
 * issue and of content-collections silently dropping 2,758 of 3,000 documents
 * while exiting 0. Measured: a limit of 64 is ~28% faster than unbounded on a
 * 10k-file corpus, as well as being correct.
 *
 * Results are returned in input order. The first rejection wins; in-flight work
 * is allowed to settle so no unhandled rejections escape.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  n: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const total = items.length
  if (total === 0) return []
  const limit = Math.max(1, Math.min(n, total))
  const results = new Array<R>(total)
  let next = 0
  let failure: { error: unknown } | undefined

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++
      if (index >= total || failure) return
      try {
        results[index] = await fn(items[index]!, index)
      } catch (error) {
        // Record the first failure only; peers unwind on their next check.
        failure ??= { error }
        return
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, worker))
  if (failure) throw failure.error
  return results
}
