/**
 * Disk-backed embedding cache (A3) — implements {@link EmbeddingCachePort}.
 *
 * Layout: a single JSON manifest (`textHash → { dimensions, vector }`) at the
 * configured path (the orchestrator, A5, derives it as
 * `~/.typocop/<prefix>/cache/embedding-cache.json`). Loaded entries are held in
 * memory; `get` is synchronous so the hot embedding loop never awaits disk.
 *
 * BOUND: the live entry count is capped at {@link getConfiguredEmbeddingCacheMaxEntries}.
 * Two complementary mechanisms keep it bounded:
 *  - `prune(live)` drops every entry NOT touched by the current run (the
 *    orchestrator passes the set of embed-text hashes the run actually used), so
 *    the cache tracks the current corpus rather than every text ever embedded.
 *  - `setMany` enforces a hard ceiling: if inserting would exceed the cap, the
 *    OLDEST entries (by insertion order) are evicted first. With a `Map`,
 *    insertion order is iteration order, giving a simple FIFO eviction.
 *
 * Robustness contract mirrors {@link FileIndexCache}:
 *  - `load` (constructor-time) NEVER throws — missing/unreadable/corrupt manifest
 *    yields an empty cache, so embedding degrades to a full (uncached) run.
 *  - `flush` writes atomically (temp + rename); a reader never sees a partial
 *    manifest.
 *
 * PRIVACY: stores only the embed-text HASH (sha256) and the resulting vector —
 * never source code. Reusing a stored vector requires a matching dimension tag,
 * so a model swap (different `dimensions`) is treated as a miss.
 *
 * LAYERING: self-contained — only `node:` builtins, the core port type, and the
 * `platform/` limits helper. No sibling-infra imports.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Embedding } from "../../core/domain.js";
import type { EmbeddingCachePort } from "../../core/ports/embedding-cache.js";
import { getConfiguredEmbeddingCacheMaxEntries } from "../../platform/utils/limits.js";

/** One persisted cache row: the embedding dimension tag plus the raw vector. */
interface CachedEmbedding {
  readonly dimensions: number;
  readonly vector: number[];
}

/** On-disk manifest envelope. `version` is the manifest format, not a model tag. */
interface EmbeddingCacheManifest {
  readonly version: 1;
  readonly entries: Record<string, CachedEmbedding>;
}

const MANIFEST_VERSION = 1 as const;

/**
 * @param filePath - Absolute path to the JSON manifest file.
 * @param maxEntries - Hard ceiling on live entries (FIFO eviction once exceeded).
 *   Defaults to {@link getConfiguredEmbeddingCacheMaxEntries} (env-overridable).
 */
export class FileEmbeddingCache implements EmbeddingCachePort {
  private readonly entries: Map<string, CachedEmbedding>;
  private readonly maxEntries: number;

  constructor(
    private readonly filePath: string,
    maxEntries: number = getConfiguredEmbeddingCacheMaxEntries(),
  ) {
    // Cap must be >= 1; a non-positive cap would evict everything on every write.
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
    this.entries = loadEntriesSync(filePath);
  }

  get(textHash: string, dims: number): Embedding | undefined {
    const hit = this.entries.get(textHash);
    if (hit === undefined) return undefined;
    // Dimension mismatch = miss: the stored vector belongs to a different model
    // and must NOT be reused (an A4 diff-write would otherwise persist a vector
    // of the wrong width).
    if (hit.dimensions !== dims) return undefined;
    return { vector: hit.vector, dimensions: hit.dimensions };
  }

  setMany(
    incoming: ReadonlyArray<{ readonly textHash: string; readonly embedding: Embedding }>,
  ): void {
    for (const { textHash, embedding } of incoming) {
      // Re-inserting an existing key keeps its current position under FIFO; to
      // refresh recency on overwrite we delete first so it moves to the tail.
      if (this.entries.has(textHash)) this.entries.delete(textHash);
      this.entries.set(textHash, {
        dimensions: embedding.dimensions,
        vector: embedding.vector,
      });
    }
    this.evictToCap();
  }

  prune(live: ReadonlySet<string>): void {
    for (const key of this.entries.keys()) {
      if (!live.has(key)) this.entries.delete(key);
    }
  }

  async flush(): Promise<void> {
    const manifest: EmbeddingCacheManifest = {
      version: MANIFEST_VERSION,
      entries: Object.fromEntries(this.entries),
    };
    const payload = JSON.stringify(manifest);

    await mkdir(dirname(this.filePath), { recursive: true });

    // Atomic temp + rename: a reader never sees a partial write. The temp lives
    // in the same directory so the rename is a same-filesystem atomic move.
    const tmpPath = join(
      dirname(this.filePath),
      `.embedding-cache.${process.pid}.${Date.now()}.tmp`,
    );
    await writeFile(tmpPath, payload, "utf8");
    try {
      await rename(tmpPath, this.filePath);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  /** Evict oldest entries (insertion order) until within the cap. */
  private evictToCap(): void {
    if (this.entries.size <= this.maxEntries) return;
    const overflow = this.entries.size - this.maxEntries;
    let dropped = 0;
    for (const key of this.entries.keys()) {
      if (dropped >= overflow) break;
      this.entries.delete(key);
      dropped++;
    }
  }
}

/**
 * Synchronously load the manifest into a `Map`. NEVER throws — a missing,
 * unreadable, or corrupt manifest yields an empty map so embedding degrades to a
 * full (uncached) run. Synchronous so the constructor can populate the in-memory
 * map without an async load step on the hot path.
 */
function loadEntriesSync(filePath: string): Map<string, CachedEmbedding> {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return new Map();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const entries = extractEntries(parsed);
    if (!entries) return new Map();
    const map = new Map<string, CachedEmbedding>();
    for (const [hash, value] of Object.entries(entries)) {
      if (isCachedEmbedding(value)) map.set(hash, value);
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Narrow an unknown parsed value to the manifest's `entries` record, else null. */
function extractEntries(parsed: unknown): Record<string, unknown> | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const entries = obj.entries;
  if (typeof entries !== "object" || entries === null) return null;
  return entries as Record<string, unknown>;
}

/** Structural guard: a row must have a numeric `dimensions` and a number[] vector. */
function isCachedEmbedding(value: unknown): value is CachedEmbedding {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.dimensions === "number" &&
    Array.isArray(row.vector) &&
    row.vector.every((n) => typeof n === "number")
  );
}
