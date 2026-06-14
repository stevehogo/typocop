/**
 * Bounded-concurrency async map.
 *
 * A tiny, dependency-free worker-pool helper used to cap how many async
 * operations run at once (e.g. parsing or embedding) without an unbounded
 * `Promise.all`. It is deliberately generic and lives in `platform/utils` so
 * any layer may reuse it.
 *
 * DETERMINISM: the returned array is indexed by INPUT position — `result[i]`
 * always corresponds to `items[i]`, regardless of which task settles first.
 * This makes downstream output order independent of completion order, which is
 * what callers (and their tests) rely on.
 */

/**
 * Map over `items` with at most `limit` concurrent invocations of `fn`.
 *
 * Workers pull indices from a shared cursor until the input is exhausted, so a
 * slow item only blocks its own slot — not the whole batch. Results are written
 * into a pre-sized array at the item's original index, preserving order.
 *
 * Rejections propagate: if any `fn(item, index)` rejects, the returned promise
 * rejects with that error (the first to settle as a rejection). Callers that
 * must be failure-tolerant should have `fn` catch internally and return a
 * sentinel rather than throwing — `buildSearchIndex` does exactly this so one
 * bad embedding never rejects the whole index.
 *
 * @param items - Inputs to process; an empty array resolves to `[]`.
 * @param limit - Maximum number of concurrent `fn` calls. Clamped to at least 1
 *   and never exceeds `items.length`.
 * @param fn    - Async mapper invoked with each item and its original index.
 * @returns Promise resolving to results in input order (`result[i]` ↔ `items[i]`).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const total = items.length;
  const results = new Array<R>(total);
  if (total === 0) return results;

  const workerCount = Math.min(Math.max(1, Math.floor(limit)), total);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= total) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
}
