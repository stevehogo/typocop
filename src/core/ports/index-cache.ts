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
  readonly kind: "import" | "call" | "inherits" | "implements" | "access";
  readonly sourceFile: string;
  readonly targetName: string;
  readonly childSymbolId?: string;
  readonly startLine: number;
  readonly language: Language;
  // ── E1 deeper-resolution + E3 member.access carriers (OPTIONAL; additive) ──
  // Kept structurally in sync with `RawRelationshipHint` so cached hints (which
  // are JSON-round-tripped) preserve these fields across the incremental path.
  readonly receiverText?: string;
  readonly enclosingSymbolId?: string;
  // ── Wave 3 Tier-B receiver-type carrier (OPTIONAL; additive; `call` hints) ──
  // Mirror of `RawRelationshipHint.receiverType` (the AST type-env's resolved
  // receiver type NAME). Without this field the incremental cache would silently
  // DROP it on a cache-reuse run, disabling Tier-B member-call resolution for
  // unchanged files. Kept structurally in sync.
  readonly receiverType?: string;
  // ── Wave 4 call-resolution precision carriers (OPTIONAL; additive; `call`) ──
  // Mirror of `RawRelationshipHint.argCount` / `callForm`. Without these the
  // incremental cache would silently DROP them on a cache-reuse run, disabling
  // Wave 4's arity / callable-kind filtering for unchanged files. The literal
  // union is re-stated here (not imported) so `core/` stays a leaf; it assigns
  // freely against `RawRelationshipHint.callForm` under structural typing. Kept
  // structurally in sync.
  readonly argCount?: number;
  readonly callForm?: "free" | "member" | "constructor";
  // ── Wave 1 named-binding carrier (OPTIONAL; additive; `import` hints only) ──
  // Mirror of `RawRelationshipHint.namedBindings`. Without this field the
  // incremental cache would silently DROP named bindings on a cache-reuse run,
  // turning off Tier 2a-named for unchanged files. Kept structurally in sync.
  readonly namedBindings?: { local: string; exported: string }[];
}

/**
 * A cached extracted HTTP route (Wave 6). Pure JSON — structurally identical to
 * `ExtractedRoute` (`infrastructure/parsing/frameworks/extracted-records.ts`);
 * re-stated here so `core/` stays a leaf. Kept structurally in sync. Without
 * round-tripping these through the cache, a warm-cache (unchanged) file would
 * silently DROP its framework routes on the incremental path.
 */
export interface CachedExtractedRoute {
  readonly filePath: string;
  readonly httpMethod: string;
  readonly routePath: string | null;
  readonly controllerName: string | null;
  readonly methodName: string | null;
  readonly middleware: string[];
  readonly prefix: string | null;
  readonly lineNumber: number;
  readonly handlerNodeId?: string;
}

/**
 * A cached extracted event subscriber (Wave 6). Pure JSON — structurally
 * identical to `ExtractedEventSubscriber`; re-stated here so `core/` stays a
 * leaf. Kept structurally in sync.
 */
export interface CachedExtractedEventSubscriber {
  readonly filePath: string;
  readonly topicName: string;
  readonly className: string | null;
  readonly methodName: string | null;
  readonly framework: string;
  readonly lineNumber: number;
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
  /**
   * Wave 6 framework routes for this file (OPTIONAL; additive). Present only when
   * the framework pass ran and produced records, so warm-cache (unchanged) files
   * re-emit them on the incremental path instead of dropping them.
   */
  readonly routes?: CachedExtractedRoute[];
  /** Wave 6 framework event subscribers for this file (OPTIONAL; additive). */
  readonly eventSubscribers?: CachedExtractedEventSubscriber[];
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
