/**
 * Persisted parse-cache port (A2).
 *
 * Decouples the indexing pipeline from where/how parse output is cached on disk
 * (or anywhere else). The disk implementation lives in `infrastructure/cache/`.
 *
 * LAYERING: `core/` is a leaf — it may import only from `core/`. The cache entry
 * stores parse output (`Symbol[]` + relationship hints), so the hint shape is
 * re-stated here as a pure, JSON-serialisable interface rather than imported
 * from `infrastructure/parsing/`. It is structurally identical to
 * `RawRelationshipHint` (the canonical declaration in
 * `infrastructure/parsing/extract-symbols.ts`), so the two assign freely under
 * TypeScript's structural typing — a cached entry's `hints` flow back into the
 * resolution phase with no conversion.
 */
import type { Language, Symbol } from "../domain.js";
import type { FileNode } from "../file-node.js";

/**
 * A raw relationship hint as persisted in the parse cache. Pure JSON — no native
 * handles. Structurally identical to `RawRelationshipHint`
 * (`infrastructure/parsing/extract-symbols.ts`); kept here so `core/` stays a
 * leaf. Do NOT add behaviour — this is a data contract only.
 */
export interface CachedRelationshipHint {
  readonly kind: "import" | "call" | "inherits" | "implements";
  readonly sourceFile: string;
  readonly targetName: string;
  readonly childSymbolId?: string;
  readonly startLine: number;
  readonly language: Language;
}

/**
 * One cache entry per source file, keyed by its cwd-relative path.
 *
 * Two-tier staleness: a cheap `mtimeMs` compare gates a `sha256(content)`
 * confirm — `contentHash` is authoritative, `mtimeMs` is the fast pre-filter.
 * `parseVersion` invalidates the WHOLE cache when extraction/grammar logic
 * changes (see {@link PARSE_VERSION}).
 */
export interface CachedFileEntry {
  /** `sha256Hex` of the file's UTF-8 content (authoritative staleness check). */
  readonly contentHash: string;
  /** `fs.Stats.mtimeMs` at parse time — the cheap first-tier staleness pre-filter. */
  readonly mtimeMs: number;
  /** Extraction/grammar version this entry was produced under (see {@link PARSE_VERSION}). */
  readonly parseVersion: number;
  /** Symbols extracted from the file (already deduplicated within the file). */
  readonly symbols: Symbol[];
  /** Raw relationship hints extracted from the file (re-resolved globally each run). */
  readonly hints: CachedRelationshipHint[];
}

/**
 * Result of classifying the freshly walked file set against the loaded cache.
 *
 * `unchanged | changed | added` are {@link FileNode}s from the current walk;
 * `removed` are cache-key paths no longer present on disk. The four buckets
 * partition the union (current walk ∪ cached keys) with no overlap.
 */
export interface FileClassification {
  /** In cache, content identical → reuse cached `{symbols,hints}`, skip re-parse. */
  readonly unchanged: FileNode[];
  /** In cache but content/parseVersion differs → re-parse. */
  readonly changed: FileNode[];
  /** Not in cache → parse for the first time. */
  readonly added: FileNode[];
  /** In cache but gone from the walk → drop from cache (and, in A4, from the DB). */
  readonly removed: string[];
}

/**
 * Disk-backed, content-addressed parse cache (A2).
 *
 * `load` NEVER throws — a missing or corrupt manifest yields an empty `Map`, so
 * the pipeline degrades to a full parse. `save` writes atomically (temp +
 * rename) and is called by the orchestrator (A5) ONLY after persist succeeds,
 * so the cache can never desync ahead of the DB on a crash. `clear` backs
 * `--refresh`.
 */
export interface IndexCachePort {
  load(): Promise<Map<string, CachedFileEntry>>;
  save(entries: Map<string, CachedFileEntry>): Promise<void>;
  clear(): Promise<void>;
}
