/**
 * Embedding-cache port (A3).
 *
 * Decouples the search/indexing phase from where/how embeddings are cached. The
 * disk-backed implementation lives in `infrastructure/cache/`. This saves the
 * *other* expensive indexing phase (embedding inference) on re-index: an
 * unchanged symbol whose formatted embed-text hashes to a previously-seen value
 * reuses its stored {@link Embedding} with NO embed call.
 *
 * IDENTITY CONTRACT: an entry is keyed by `sha256(embedText)` PLUS the embedding
 * `dimensions`. The text hash captures everything that affects the embedding
 * (kind, name, signature, docs, …) via {@link formatSymbolForEmbedding} /
 * {@link formatClusterForEmbedding}; the dimension tag guards against a model
 * swap — a hit whose stored embedding has a different dimension count is a MISS
 * (the cached vector belongs to a different model and must not be reused). The
 * cache stores no source code, only the embed-text HASH and the resulting
 * vector, so it never widens the privacy surface.
 *
 * LAYERING: `core/` is a leaf — it imports only from `core/`. The
 * {@link Embedding} value type lives in `core/domain.ts`.
 */
import type { Embedding } from "../domain.js";

/**
 * In-memory (optionally disk-flushed) cache of embed-text hash → {@link Embedding}.
 *
 * Lifecycle within one indexing run (driven by the orchestrator):
 *  1. construct / load prior entries,
 *  2. `get(textHash, dims)` per embed job — a hit skips the embed call,
 *  3. `setMany(...)` records freshly-computed embeddings,
 *  4. `prune(live)` drops every entry whose hash is NOT in this run's live set
 *     (so the cache tracks the current corpus and cannot grow unbounded),
 *  5. `flush()` persists.
 *
 * `get` returns `undefined` on a miss OR a dimension mismatch — callers treat
 * both identically (compute the embedding).
 */
export interface EmbeddingCachePort {
  /**
   * Look up a cached embedding by its embed-text hash. Returns the stored
   * {@link Embedding} ONLY when an entry exists AND its `dimensions === dims`;
   * a dimension mismatch (model swap) is reported as a miss (`undefined`).
   */
  get(textHash: string, dims: number): Embedding | undefined;
  /**
   * Record freshly-computed embeddings. Idempotent per `textHash` — a later
   * write for the same hash overwrites the earlier one.
   */
  setMany(
    entries: ReadonlyArray<{ readonly textHash: string; readonly embedding: Embedding }>,
  ): void;
  /**
   * Drop every entry whose hash is NOT in `live` (the set of hashes the current
   * run actually touched), enforcing the "prune-to-live" bound each run so the
   * cache never accumulates dead corpus.
   */
  prune(live: ReadonlySet<string>): void;
  /** Persist the current entries (no-op for a purely in-memory implementation). */
  flush(): Promise<void>;
}
