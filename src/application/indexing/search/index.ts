// Phase 6: Search index orchestrator
// Combines keyword indexing and embedding generation into a unified SearchIndex

import type { Symbol, Cluster, Embedding } from "../../../core/domain.js";
import type { EmbeddingCachePort } from "../../../core/ports/embedding-cache.js";
import { buildKeywordIndex } from "./keywords.js";
import { formatSymbolForEmbedding, formatClusterForEmbedding } from "./format.js";
import { mapWithConcurrency } from "../../../platform/utils/async-pool.js";
import { sha256Hex } from "../../../platform/utils/hash.js";
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
  /**
   * Items (symbols + clusters) for which an embedding was ATTEMPTED via the
   * embed function. Cache hits (A3) are NOT counted here — they never call the
   * embed function — so this stays a faithful measure of inference work done.
   */
  readonly attempts: number;
  /** Items that produced a usable embedding. */
  readonly successes: number;
  /** Items that yielded no embedding (null result, timeout, or thrown error). */
  readonly failures: number;
  /**
   * Items (A3) served from the embedding cache — a stored vector reused with NO
   * embed call. Omitted (undefined) when no embedding cache is wired, so the
   * field is additive and does NOT inflate {@link attempts}. A cache hit still
   * contributes its embedding to {@link SearchIndex.embeddings}.
   */
  readonly embeddingCacheHits?: number;
}

export interface SearchIndex {
  readonly keywords: Map<string, string[]>;
  readonly symbolCount: number;
  readonly embeddings: EmbeddingResult[];
  /** Embedding success/failure accounting for this run (Phase C). */
  readonly embeddingStats: EmbeddingStats;
  /**
   * A3: the set of embed-text hashes this run touched (every job's
   * `sha256(text)`), surfaced ONLY when an embedding cache was active. The
   * orchestrator passes it to {@link EmbeddingCachePort.prune} so the cache is
   * trimmed to the live corpus each run. Undefined when no cache was wired.
   */
  readonly liveEmbeddingHashes?: ReadonlySet<string>;
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
 *
 * EMBEDDING CACHE (A3): when an {@link EmbeddingCachePort} and the expected
 * embedding `dimensions` are supplied, each job's embed-text is hashed
 * (`sha256(text)`) and looked up BEFORE embedding. A hit synthesizes the
 * {@link EmbeddingResult} from the stored vector with NO embed call (counted in
 * {@link EmbeddingStats.embeddingCacheHits}, NOT in `attempts`); a
 * dimension-mismatch is a miss. Only the misses flow through the embed/batch
 * path; their fresh embeddings are written back to the cache. Determinism is
 * preserved — results stay aligned to the original job index regardless of which
 * jobs hit the cache or which embed call settles first.
 *
 * @param embeddingCache - OPTIONAL A3 cache. When provided WITH
 *   `expectedDimensions`, unchanged inputs reuse stored vectors and skip embed.
 * @param expectedDimensions - The embedding model's dimension count (from
 *   `EmbeddingAdapter.getDimensions()`); the cache key's dimension tag. Required
 *   for the cache to engage — a hit whose stored dimension differs is a miss.
 */
export async function buildSearchIndex(
  symbols: Symbol[],
  clusters: Cluster[],
  embedFn: ((text: string) => Promise<Embedding | null>) | null,
  concurrency: number = EMBEDDING_CONCURRENCY,
  embedTextsFn:
    | ((texts: string[]) => Promise<(Embedding | null)[]>)
    | null = null,
  embeddingCache: EmbeddingCachePort | null = null,
  expectedDimensions: number | null = null,
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

  // A3 EMBEDDING CACHE — resolve cache hits up front, then embed only the misses.
  // The cache engages only when both a port AND the expected dimension are
  // supplied (the dimension is the cache key's model tag; without it a stored
  // vector can't be safely matched). `settled` is index-aligned to `jobs`; hits
  // fill their slot immediately, misses are scattered back to their slot below.
  const cacheActive = embeddingCache !== null && expectedDimensions !== null;

  // Per-job embed-text hash (computed once; reused for lookup AND write-back).
  const hashes: string[] = cacheActive ? jobs.map((j) => sha256Hex(j.text)) : [];

  const settled: (EmbeddingResult | null)[] = new Array(jobs.length).fill(null);
  // Misses keep their ORIGINAL index so results land in the right slot.
  const missJobs: EmbedJob[] = [];
  const missIndices: number[] = [];
  let cacheHits = 0;

  if (cacheActive && embeddingCache !== null && expectedDimensions !== null) {
    for (let i = 0; i < jobs.length; i++) {
      const cached = embeddingCache.get(hashes[i], expectedDimensions);
      if (cached !== undefined) {
        // Hit: synthesize the result from the stored vector — NO embed call.
        settled[i] = jobs[i].toResult(cached);
        cacheHits++;
      } else {
        missJobs.push(jobs[i]);
        missIndices.push(i);
      }
    }
  } else {
    // No cache: every job is a miss (embedded), preserving prior behavior.
    for (let i = 0; i < jobs.length; i++) {
      missJobs.push(jobs[i]);
      missIndices.push(i);
    }
  }

  const useBatch = embedTextsFn !== null && isEmbeddingBatchEnabled();

  let missResults: (EmbeddingResult | null)[];
  if (useBatch && embedTextsFn !== null) {
    missResults = await runBatched(missJobs, concurrency, embedTextsFn, embedJobItem);
  } else {
    // Per-item path: bounded concurrency over individual (miss) jobs.
    missResults = await mapWithConcurrency(missJobs, concurrency, embedJobItem);
  }

  // Scatter miss results back to their original job index (determinism), and
  // collect freshly-computed embeddings for write-back to the cache.
  const freshEntries: { textHash: string; embedding: Embedding }[] = [];
  for (let m = 0; m < missJobs.length; m++) {
    const originalIndex = missIndices[m];
    const result = missResults[m];
    settled[originalIndex] = result;
    if (cacheActive && result !== null) {
      freshEntries.push({ textHash: hashes[originalIndex], embedding: result.embedding });
    }
  }
  if (cacheActive && embeddingCache !== null && freshEntries.length > 0) {
    embeddingCache.setMany(freshEntries);
  }

  // Flatten in input order (determinism preserved) and tally failures. Cache
  // hits are NOT attempts (no embed call); only the misses are attempts.
  const collected: EmbeddingResult[] = [];
  for (const result of settled) {
    if (result !== null) collected.push(result);
  }

  const attempts = missJobs.length;
  const successes = collected.length - cacheHits;

  const embeddingStats: EmbeddingStats = {
    attempts,
    successes,
    failures: attempts - successes,
    ...(cacheActive ? { embeddingCacheHits: cacheHits } : {}),
  };

  return {
    keywords,
    symbolCount: symbols.length,
    embeddings: collected,
    embeddingStats,
    ...(cacheActive ? { liveEmbeddingHashes: new Set(hashes) } : {}),
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
