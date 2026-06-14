// Phase 6: Search index orchestrator
// Combines keyword indexing and embedding generation into a unified SearchIndex

import type { Symbol, Cluster, Embedding } from "../../../core/domain.js";
import { buildKeywordIndex } from "./keywords.js";
import { formatSymbolForEmbedding, formatClusterForEmbedding } from "./format.js";
import { mapWithConcurrency } from "../../../platform/utils/async-pool.js";
import {
  EMBEDDING_CONCURRENCY,
  EMBEDDING_TIMEOUT_MS,
  EMBEDDING_BATCH_TIMEOUT_CAP_MS,
  getConfiguredEmbeddingBatchSize,
  isEmbeddingBatchEnabled,
  withTimeoutOr,
} from "../../../platform/utils/limits.js";

export interface EmbeddingResult {
  readonly symbolId: string;
  readonly embedding: Embedding;
  readonly metadata: Record<string, string>;
}

/**
 * Embedding failure/attempt accounting for a single {@link buildSearchIndex}
 * run. A "failure" is any item that yielded no usable embedding: the embed
 * function returned `null`, timed out, or threw. Failures are NOT errors — they
 * degrade the affected item to keyword-only search; the pipeline never fails.
 */
export interface EmbeddingStats {
  /** Items (symbols + clusters) for which an embedding was attempted. */
  readonly attempts: number;
  /** Items that produced a usable embedding. */
  readonly successes: number;
  /** Items that yielded no embedding (null result, timeout, or thrown error). */
  readonly failures: number;
}

export interface SearchIndex {
  readonly keywords: Map<string, string[]>;
  readonly symbolCount: number;
  readonly embeddings: EmbeddingResult[];
  /** Embedding success/failure accounting for this run (Phase C). */
  readonly embeddingStats: EmbeddingStats;
}

/**
 * One embedding job: the privacy-checked text to embed plus the
 * {@link EmbeddingResult} factory to use if it succeeds. Building the text up
 * front keeps the privacy/redaction checks (`formatSymbolForEmbedding` /
 * `formatClusterForEmbedding`, which call `verifyEmbeddingText`) on the exact
 * same path as before — concurrency does not bypass them.
 */
interface EmbedJob {
  readonly text: string;
  readonly toResult: (embedding: Embedding) => EmbeddingResult;
}

/**
 * Builds a hybrid search index combining keyword and embedding indexing.
 *
 * Keyword indexing ALWAYS runs (Req 8.5). Embedding generation, when enabled,
 * runs with BOUNDED concurrency (no unbounded `Promise.all`) and a per-item
 * timeout, so one slow/hanging embed cannot stall the index. Any item that
 * returns `null`, times out, or throws is counted as a failure and skipped —
 * it degrades to keyword-only; the call never rejects.
 *
 * DETERMINISM: jobs are built in a fixed order (all symbols, then all clusters)
 * and {@link mapWithConcurrency} writes results back by input index, so the
 * returned `embeddings[]` order is stable for a fixed input regardless of which
 * embed call settles first.
 *
 * BATCHING (Phase 1): when an `embedTextsFn` is supplied (the adapter exposes
 * the OPTIONAL `embedTexts` fast-path) AND batching is not disabled via env,
 * jobs are grouped into fixed-size batches and the BATCHES are fed through
 * {@link mapWithConcurrency}. Each batch's results are scattered back to their
 * ORIGINAL job indices, so the returned `embeddings[]` order is identical to the
 * per-item path for a fixed input (determinism preserved). On batch
 * timeout/throw (inference is all-or-nothing), the batch's texts fall back to
 * the per-item `embedFn` + per-item timeout path EXACTLY ONCE (no recursion, no
 * re-batching), so per-item failure accounting is preserved and a hanging
 * adapter cannot cause unbounded retries.
 *
 * @param symbols - All symbols to index
 * @param clusters - All clusters to index (embeddings only)
 * @param embedFn - Per-item embedding function, or null to skip embedding generation
 * @param concurrency - Max concurrent embed calls (default {@link EMBEDDING_CONCURRENCY})
 * @param embedTextsFn - OPTIONAL batch embedding function. Used as the fast-path
 *   only when provided AND batching is explicitly enabled (opt-in, default off —
 *   see {@link isEmbeddingBatchEnabled}); `embedFn` remains the per-item path.
 */
export async function buildSearchIndex(
  symbols: Symbol[],
  clusters: Cluster[],
  embedFn: ((text: string) => Promise<Embedding | null>) | null,
  concurrency: number = EMBEDDING_CONCURRENCY,
  embedTextsFn:
    | ((texts: string[]) => Promise<(Embedding | null)[]>)
    | null = null,
): Promise<SearchIndex> {
  const keywords = buildKeywordIndex(symbols);

  if (embedFn === null) {
    return {
      keywords,
      symbolCount: symbols.length,
      embeddings: [],
      embeddingStats: { attempts: 0, successes: 0, failures: 0 },
    };
  }

  // Build all jobs in deterministic order: symbols first, then clusters,
  // matching the historical ordering. Formatting (and its privacy checks) runs
  // here, before any concurrency.
  const jobs: EmbedJob[] = [];

  for (const symbol of symbols) {
    jobs.push({
      text: formatSymbolForEmbedding(symbol),
      toResult: (embedding) => ({
        symbolId: symbol.id,
        embedding,
        metadata: {
          kind: symbol.kind,
          filePath: symbol.location.filePath,
        },
      }),
    });
  }

  const symbolMap = new Map<string, Symbol>(symbols.map(s => [s.id, s]));
  for (const cluster of clusters) {
    const clusterSymbols = cluster.symbols
      .map(id => symbolMap.get(id))
      .filter((s): s is Symbol => s !== undefined);
    const firstSymbol = clusterSymbols[0];
    jobs.push({
      text: formatClusterForEmbedding(cluster, clusterSymbols),
      toResult: (embedding) => ({
        symbolId: `cluster:${cluster.id}`,
        embedding,
        metadata: {
          clusterId: cluster.id,
          clusterName: cluster.name,
          category: cluster.category,
          ...(firstSymbol ? {
            filePath: firstSymbol.location.filePath,
            kind: firstSymbol.kind,
            symbolId: firstSymbol.id,
          } : {}),
        },
      }),
    });
  }

  // Per-item embed of a single job (the universal fallback). Failure-tolerant:
  // a null result, timeout, or thrown error resolves to `null` rather than
  // rejecting.
  const embedJobItem = (job: EmbedJob): Promise<EmbeddingResult | null> =>
    withTimeoutOr(
      async () => {
        const embedding = await embedFn(job.text);
        return embedding === null ? null : job.toResult(embedding);
      },
      EMBEDDING_TIMEOUT_MS,
      null,
    ).catch(() => null);

  const useBatch = embedTextsFn !== null && isEmbeddingBatchEnabled();

  let settled: (EmbeddingResult | null)[];
  if (useBatch && embedTextsFn !== null) {
    settled = await runBatched(jobs, concurrency, embedTextsFn, embedJobItem);
  } else {
    // Per-item path: bounded concurrency over individual jobs.
    settled = await mapWithConcurrency(jobs, concurrency, embedJobItem);
  }

  // Flatten in input order (determinism preserved) and tally failures.
  const collected: EmbeddingResult[] = [];
  for (const result of settled) {
    if (result !== null) collected.push(result);
  }

  const attempts = jobs.length;
  const successes = collected.length;

  return {
    keywords,
    symbolCount: symbols.length,
    embeddings: collected,
    embeddingStats: { attempts, successes, failures: attempts - successes },
  };
}

/**
 * Run embedding generation via the batched `embedTexts` fast-path.
 *
 * Jobs are grouped into fixed-size batches (EMBEDDING_BATCH_SIZE). The BATCHES
 * are fed through {@link mapWithConcurrency} at `concurrency`, so at most
 * `concurrency` batches are in flight at once. Each batch's results are
 * scattered back to the ORIGINAL job indices, preserving determinism: the
 * returned array is index-aligned to `jobs` regardless of completion order.
 *
 * TIMEOUT / FAILURE POLICY (embeddings performance plan, Phase 1, option (b)):
 *   - Per-batch timeout = min(EMBEDDING_TIMEOUT_MS × batch.length,
 *     EMBEDDING_BATCH_TIMEOUT_CAP_MS). It is NOT amortized per item.
 *   - Happy path: batch resolves → scatter N results; each item is later counted
 *     individually in EmbeddingStats (success or per-row null).
 *   - Timeout/throw path: the whole batch is suspect (inference is
 *     all-or-nothing). Re-run the batch's jobs through the per-item `embedJobItem`
 *     path (which itself applies the per-item EMBEDDING_TIMEOUT_MS) EXACTLY ONCE
 *     — no recursion, no re-batching. This is the only place per-item accounting
 *     is recovered for a failed batch; worst case is the pre-batch behavior plus
 *     one wasted batch attempt.
 */
async function runBatched(
  jobs: EmbedJob[],
  concurrency: number,
  embedTextsFn: (texts: string[]) => Promise<(Embedding | null)[]>,
  embedJobItem: (job: EmbedJob) => Promise<EmbeddingResult | null>,
): Promise<(EmbeddingResult | null)[]> {
  const batchSize = getConfiguredEmbeddingBatchSize();
  const settled: (EmbeddingResult | null)[] = new Array(jobs.length).fill(null);

  // Build batches as { startIndex, jobs }, preserving original ordering so each
  // result can be scattered back to its global job index.
  interface Batch {
    readonly start: number;
    readonly items: EmbedJob[];
  }
  const batches: Batch[] = [];
  for (let i = 0; i < jobs.length; i += batchSize) {
    batches.push({ start: i, items: jobs.slice(i, i + batchSize) });
  }

  await mapWithConcurrency(batches, concurrency, async (batch) => {
    const texts = batch.items.map((job) => job.text);
    const perBatchTimeout = Math.min(
      EMBEDDING_TIMEOUT_MS * batch.items.length,
      EMBEDDING_BATCH_TIMEOUT_CAP_MS,
    );

    // Sentinel marks a batch-level failure (timeout OR throw) → fall back.
    const FAILED = Symbol("batch-failed");
    const outcome: (Embedding | null)[] | typeof FAILED = await withTimeoutOr<
      (Embedding | null)[] | typeof FAILED
    >(
      () => embedTextsFn(texts),
      perBatchTimeout,
      FAILED,
    ).catch(() => FAILED);

    if (outcome !== FAILED) {
      // Happy path — scatter each row to its global index.
      for (let k = 0; k < batch.items.length; k++) {
        const embedding = outcome[k] ?? null;
        settled[batch.start + k] =
          embedding === null ? null : batch.items[k].toResult(embedding);
      }
      return;
    }

    // Fallback path — the whole batch is suspect. Re-run its jobs through the
    // per-item path EXACTLY ONCE (no recursion, no re-batching).
    const recovered = await mapWithConcurrency(
      batch.items,
      concurrency,
      embedJobItem,
    );
    for (let k = 0; k < batch.items.length; k++) {
      settled[batch.start + k] = recovered[k];
    }
  });

  return settled;
}

export { formatSymbolForEmbedding, formatClusterForEmbedding } from "./format.js";
export { extractKeywords, buildKeywordIndex } from "./keywords.js";
