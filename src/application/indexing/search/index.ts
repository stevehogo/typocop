// Phase 6: Search index orchestrator
// Combines keyword indexing and embedding generation into a unified SearchIndex

import type { Symbol, Cluster, Embedding } from "../../../core/domain.js";
import { buildKeywordIndex } from "./keywords.js";
import { formatSymbolForEmbedding, formatClusterForEmbedding } from "./format.js";
import { mapWithConcurrency } from "../../../platform/utils/async-pool.js";
import { EMBEDDING_CONCURRENCY, EMBEDDING_TIMEOUT_MS, withTimeoutOr } from "../../../platform/utils/limits.js";

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
 * @param symbols - All symbols to index
 * @param clusters - All clusters to index (embeddings only)
 * @param embedFn - Embedding function, or null to skip embedding generation
 * @param concurrency - Max concurrent embed calls (default {@link EMBEDDING_CONCURRENCY})
 */
export async function buildSearchIndex(
  symbols: Symbol[],
  clusters: Cluster[],
  embedFn: ((text: string) => Promise<Embedding | null>) | null,
  concurrency: number = EMBEDDING_CONCURRENCY,
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

  // Run with bounded concurrency. Each job is failure-tolerant: a null result,
  // timeout, or thrown error resolves to `null` rather than rejecting the batch.
  const settled = await mapWithConcurrency(
    jobs,
    concurrency,
    (job): Promise<EmbeddingResult | null> =>
      withTimeoutOr(
        async () => {
          const embedding = await embedFn(job.text);
          return embedding === null ? null : job.toResult(embedding);
        },
        EMBEDDING_TIMEOUT_MS,
        null,
      ).catch(() => null),
  );

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

export { formatSymbolForEmbedding, formatClusterForEmbedding } from "./format.js";
export { extractKeywords, buildKeywordIndex } from "./keywords.js";
