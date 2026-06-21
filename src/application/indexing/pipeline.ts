/**
 * Indexing pipeline orchestrator — wires all 6 phases together.
 *
 * Transforms source code into a queryable knowledge graph stored via DatabaseAdapter.
 * The pipeline executes sequentially through 6 phases, storing results through
 * GraphAdapter (nodes/edges) and VectorAdapter (embeddings).
 *
 * Requirements: 1.1, 1.6, 1.7, 3.1–3.8, 8.1–8.5
 */
import type {
  Cluster,
  Embedding,
  ExternalDependencyNode,
  Language,
  Process,
  Relationship,
  Symbol,
} from "../../core/domain.js";
import { persistedKey } from "../../core/domain.js";
import type { DatabaseAdapter, GraphAdapter, VectorAdapter, EmbeddingAdapter } from "../../core/ports/persistence.js";
import type { EmbeddingCachePort } from "../../core/ports/embedding-cache.js";
import type {
  CachedFileEntry,
  IndexCachePort,
} from "../../core/ports/index-cache.js";
import { walkFileTree, readFileContents, type FileNode } from "./structure/index.js";
import { extractAllSymbols, extractAllSymbolsWithPerFile } from "./parsing/index.js";
import { classifyFiles } from "./cache/classify.js";
import { PARSE_VERSION } from "../../infrastructure/parsing/parse-version.js";
import { sha256Hex } from "../../platform/utils/hash.js";
import { resolveReferences } from "./resolution/index.js";
import { clusterSymbols, type AIClient } from "./clustering/index.js";
import { traceProcesses, annotateEntryPoints } from "./processes/index.js";
import { buildSearchIndex, type EmbeddingResult } from "./search/index.js";
import { EMBEDDING_CONCURRENCY } from "../../platform/utils/limits.js";
import { createMetricsCollector, formatMetrics, type IndexingMetrics } from "./metrics.js";
import { createProgressRenderer } from "../../platform/logging/progress.js";
import {
  writeNodeGroup,
  writeRelationshipGroup,
  writeVectorEntries,
  type RelationshipRow,
} from "./persistence-helpers.js";

/**
 * Configuration for the indexing pipeline.
 *
 * @property sourcePath - Root directory to index
 * @property language - Target language for parsing
 * @property verbose - Enable detailed progress logging
 * @property adapter - DatabaseAdapter providing graph, vector, and embedding access
 * @property aiClient - Optional AI client for cluster enrichment
 * @property semanticClassification - Opt-out (default true) for Phase 4 semantic
 *   cluster classification. Defaults preserve current behavior: semantic
 *   classification runs whenever the embedding adapter is enabled. Set false to
 *   skip Phase 4 cluster embedding when it dominates indexing time (Phase C).
 *
 * @property embeddingCache - Optional A3 embedding cache. When provided, Phase 6
 *   reuses stored vectors for unchanged inputs (keyed by `sha256(embedText)` +
 *   model dimension), skipping redundant embed calls. The pipeline prunes the
 *   cache to this run's live hashes and flushes it after the search phase.
 *
 * @property delta - Optional A4 diff-write plan. When provided AND the graph and
 *   vector adapters expose the per-file delete fast-paths
 *   (`deleteSymbolsByFilePaths`/`deleteByFilePaths`), the persist phase does a
 *   DELTA write instead of an INSERT-only write: it DETACH-DELETEs the symbol
 *   nodes + vectors of `removedAndChangedFiles`, then inserts symbol nodes +
 *   vectors only for `addedAndChangedFiles` (unchanged files' rows are left in
 *   place — that is the incremental win). Clusters/processes/external-deps and
 *   the full relationship set are still rewritten WHOLESALE (they are global
 *   aggregates; relationships re-MERGE idempotently, restoring inbound edges the
 *   DETACH DELETE transiently dropped). The merged symbol+hint set is identical
 *   to a full run, so the resulting graph is byte-identical (delta == full). If
 *   either adapter lacks the delete fast-path (e.g. the remote/gRPC adapter), the
 *   pipeline silently falls back to a full INSERT-only write.
 *
 *   File paths in `delta` MUST be in the SAME form as `Symbol.location.filePath`
 *   (that is what both the graph `filePath` property and the vector `file_path`
 *   column store), so the per-file deletes match exactly.
 *
 * Requirements: 8.1
 */
export interface PipelineDelta {
  /** Files whose existing symbol nodes + vectors must be DETACH-DELETEd first
   *  (the union of changed + removed files). */
  readonly removedAndChangedFiles: readonly string[];
  /** Files whose symbols + vectors are (re)inserted this run (changed + added).
   *  Symbols/vectors NOT in these files are left untouched in the DB. */
  readonly addedAndChangedFiles: readonly string[];
}

export interface PipelineConfig {
  readonly sourcePath: string;
  readonly language: Language;
  readonly verbose: boolean;
  readonly adapter: DatabaseAdapter;
  readonly aiClient?: AIClient;
  readonly semanticClassification?: boolean;
  readonly embeddingCache?: EmbeddingCachePort;
  /**
   * A5 incremental orchestration. Defaults to `true`. When `true` AND a
   * {@link cache} is supplied, the pipeline CLASSIFIES the walked files against
   * the loaded parse cache, re-PARSES only `changed + added` (reusing the cached
   * `{symbols,hints}` for `unchanged`), and derives a {@link PipelineDelta} from
   * the buckets so the persist phase does a per-file delta write (A4). When
   * `false` (`--full`/`--refresh`), every file is re-parsed and the graph is
   * rewritten wholesale — today's behaviour — even if a cache is present.
   *
   * The merged (cached-unchanged + freshly-parsed) symbol+hint set is IDENTICAL
   * to what a full run would build, so resolution stays GLOBAL and the resulting
   * graph is byte-identical (incremental == full). The win is skipping re-parse
   * and re-embed of unchanged files.
   */
  readonly incremental?: boolean;
  /**
   * A5 parse cache (A2). Supplied by the composition root (the CLI executor
   * derives its path from the prefix). When present AND {@link incremental} is
   * not `false`, drives the classify/merge/delta flow above and is RE-SAVED only
   * AFTER persist succeeds (crash-safety: the cache never desyncs ahead of the
   * DB). Absent → the pipeline runs the historical full path with no caching.
   */
  readonly cache?: IndexCachePort;
  readonly delta?: PipelineDelta;
}

/**
 * Result of the complete indexing pipeline execution.
 */
export interface PipelineResult {
  readonly symbols: Symbol[];
  readonly relationships: Relationship[];
  readonly clusters: Cluster[];
  readonly processes: Process[];
  readonly externalDependencyCount: number;
  readonly skippedFiles: number;
  readonly embeddingCount: number;
  /** Local timing/throughput metrics for this run; always populated. */
  readonly metrics: IndexingMetrics;
}

/**
 * Execute the complete 6-phase indexing pipeline.
 *
 * Requirements: 3.1–3.8, 8.1–8.5
 */
export async function runIndexingPipeline(config: PipelineConfig): Promise<PipelineResult> {
  const { sourcePath, verbose, adapter, aiClient } = config;
  const semanticClassification = config.semanticClassification ?? true;
  const graphAdapter = adapter.getGraphAdapter();
  const vectorAdapter = adapter.getVectorAdapter();
  const embeddingAdapter = adapter.getEmbeddingAdapter();

  // Phase A: instrument before optimizing. All measurement is local — no source
  // is ever sent to an external service.
  const metrics = createMetricsCollector();

  if (verbose) console.error("[pipeline] Starting Phase 1: Structure");

  // Phase 1: Walk file tree (Req 3.1)
  const fileNodes = await metrics.time("structure", () => walkFileTree(sourcePath));
  metrics.set("filesScanned", fileNodes.length);
  if (verbose) console.error(`[pipeline] Phase 1 complete: ${fileNodes.length} files found`);

  if (fileNodes.length === 0) {
    return finishMetrics(verbose, metrics, {
      symbols: [],
      relationships: [],
      clusters: [],
      processes: [],
      externalDependencyCount: 0,
      skippedFiles: 0,
      embeddingCount: 0,
    });
  }

  if (verbose) console.error("[pipeline] Starting Phase 2: Parsing");

  // Phase 2: Extract symbols and relationship hints (Req 3.2).
  //
  // Phase 2 is the longest CPU-bound phase; without feedback it looks like a
  // hang on large repos. The pipeline OWNS rendering (B6): it builds a renderer
  // that writes to stderr only, animates a single line on a TTY (throttled), and
  // stays quiet on non-TTY unless verbose. The renderer's `onProgress` is the
  // same per-file completion hook the bounded-concurrency loop drives.
  //
  // A5 INCREMENTAL ORCHESTRATION: when a parse cache is wired AND incremental is
  // not disabled, {@link runPhase2} classifies the walk against the cache and
  // re-parses only changed+added files (reusing cached symbols/hints for the
  // unchanged rest), then merges everything back into ORIGINAL walk order — the
  // merged set is byte-identical to a full parse, so all later (global) phases
  // produce a byte-identical graph. It also returns the A4 `delta` plan (derived
  // from the buckets) and the next cache snapshot to persist AFTER the DB write
  // succeeds. With no cache (or `--full`/`--refresh`), it runs the historical
  // full parse with no delta and nothing to save.
  const progress = createProgressRenderer({ verbose, label: "Phase 2: parsing" });
  const phase2 = await metrics.time("parsing", () =>
    runPhase2(config, fileNodes, progress.onProgress),
  );
  progress.done();
  const { symbols: phase2Symbols, hints, skippedFiles } = phase2;
  // E3: fold `member.access` hints into each consumer symbol's `accessedKeys`
  // (purely additive — see {@link attachAccessedKeys}). All later phases see the
  // augmented list; the added optional prop is ignored by resolution/clustering,
  // so the graph stays byte-identical apart from the new Symbol prop.
  // `let` (not `const`): Wave 2 re-binds it after Phase 5 with the additive
  // entry-point annotation (see {@link annotateEntryPoints}).
  let symbols = attachAccessedKeys(phase2Symbols, hints);
  metrics.set("skippedFiles", skippedFiles);
  metrics.set("filesParsed", phase2.filesParsed);
  metrics.set("symbolCount", symbols.length);
  metrics.set("hintCount", hints.length);
  if (verbose) {
    console.error(`[pipeline] Phase 2 complete: ${symbols.length} symbols extracted, ${hints.length} relationship hints`);
    if (phase2.classification) {
      const c = phase2.classification;
      console.error(
        `[pipeline] Incremental classify: reused ${c.unchanged.length} / parsed ${c.changed.length + c.added.length} ` +
          `(changed ${c.changed.length}, added ${c.added.length}, removed ${c.removed.length})`,
      );
    }
  }

  // A5: the delta plan derived from the classify buckets (undefined on a full
  // run). Threaded into `config.delta` so the persist phase below takes the A4
  // delta write path when the adapters support it.
  const effectiveDelta = phase2.delta ?? config.delta;

  if (symbols.length === 0) {
    return finishMetrics(verbose, metrics, {
      symbols: [],
      relationships: [],
      clusters: [],
      processes: [],
      externalDependencyCount: 0,
      skippedFiles,
      embeddingCount: 0,
    });
  }

  if (verbose) console.error("[pipeline] Starting Phase 3: Resolution");

  // Phase 3: Resolve references (Req 3.3)
  //
  // Wave 1: thread the repo file list (relative `fileNode.path`s — the same form
  // as `hint.sourceFile` and `Symbol.location.filePath`) so Phase 3 can resolve
  // import specifiers to concrete paths and populate the import/package/named
  // maps (Tiers 2a / 2a-named / 2b). Omitting this arg is the zero-code rollback.
  const { relationships, extNodes, dependsOnStats } = await metrics.time("resolution", () =>
    resolveReferences(symbols, hints, sourcePath, fileNodes.map((f) => f.path)),
  );
  metrics.set("relationshipCount", relationships.length);
  metrics.set("externalDependencyCount", extNodes.size);
  if (verbose) console.error(`[pipeline] Phase 3 complete: ${relationships.length} relationships resolved`);
  if (verbose && dependsOnStats) console.error(`[pipeline] Phase 3 DEPENDS_ON fan-out: ${dependsOnStats.edgeCount} edges (max ${dependsOnStats.maxFanOutPerImport} per external import)`);

  if (verbose) console.error("[pipeline] Starting Phase 4: Clustering");

  // Phase 4: Cluster symbols (Req 3.4)
  const clusters = await metrics.time("clustering", () =>
    clusterSymbols(symbols, relationships, aiClient, embeddingAdapter, semanticClassification),
  );
  metrics.set("clusterCount", clusters.length);
  if (verbose) console.error(`[pipeline] Phase 4 complete: ${clusters.length} clusters created`);

  if (verbose) console.error("[pipeline] Starting Phase 5: Processes");

  // Phase 5: Trace processes (Req 3.5)
  metrics.startPhase("processes");
  const processes = traceProcesses(symbols, relationships);
  // Wave 2 (1.1): annotate entry-point symbols with `entryPointKind` /
  // `entryPointReason` so the persisted Symbol node carries them. Purely
  // additive — symbols below the entry-point threshold are returned unchanged,
  // so search/clustering/persisted shape stay identical where no metadata
  // applies (the new optional props are ignored by every downstream phase).
  symbols = annotateEntryPoints(symbols, relationships);
  metrics.endPhase("processes");
  metrics.set("processCount", processes.length);
  if (verbose) console.error(`[pipeline] Phase 5 complete: ${processes.length} processes traced`);

  if (verbose) console.error("[pipeline] Starting Phase 6: Search indexing");

  // Phase 6: Build search index and generate embeddings (Req 3.6, 8.2–8.5)
  let embedFn: ((text: string) => Promise<Embedding | null>) | null = null;
  // OPTIONAL batch fast-path (Phase 1). Wired only when the adapter exposes
  // `embedTexts`; otherwise null and buildSearchIndex uses the per-item path.
  let embedTextsFn:
    | ((texts: string[]) => Promise<(Embedding | null)[]>)
    | null = null;

  if (embeddingAdapter.isEnabled()) {
    embedFn = (text: string) => embeddingAdapter.embedText(text);
    if (typeof embeddingAdapter.embedTexts === "function") {
      const batchFn = embeddingAdapter.embedTexts.bind(embeddingAdapter);
      embedTextsFn = (texts: string[]) => batchFn(texts);
    }
  } else {
    console.error("[pipeline] Embeddings disabled — skipping embedding generation");
  }

  // A3: the embedding cache engages only when wired AND embeddings are enabled
  // (a disabled adapter does no embed work, so there is nothing to cache). The
  // model dimension tags every cache key, so a model swap forces a clean miss.
  const embeddingCache =
    config.embeddingCache !== undefined && embeddingAdapter.isEnabled()
      ? config.embeddingCache
      : null;
  const embeddingDimensions = embeddingCache !== null
    ? embeddingAdapter.getDimensions()
    : null;

  // Keyword indexing always runs regardless of embedding state (Req 8.5).
  // Embedding generation is the bulk of the search phase cost, so attribute the
  // whole phase to embeddingElapsedMs (finer per-call granularity lives in the
  // search module; phase timing is acceptable here per Phase A).
  const searchStart = performance.now();
  const searchIndex = await metrics.time("search", () =>
    buildSearchIndex(
      symbols,
      clusters,
      embedFn,
      EMBEDDING_CONCURRENCY,
      embedTextsFn,
      embeddingCache,
      embeddingDimensions,
    ),
  );
  metrics.addElapsed("embeddingElapsedMs", performance.now() - searchStart);
  metrics.set("embeddingAttempts", searchIndex.embeddingStats.attempts);
  metrics.set("embeddingFailures", searchIndex.embeddingStats.failures);

  // A3: prune the cache to this run's live embed-text hashes (drops vectors for
  // symbols no longer present), then flush. Done after the search phase but
  // before persist — a cache flush is cheap and independent of the DB write; on
  // a persist crash the cache may hold a few extra warm vectors, which only ever
  // helps a subsequent run and never produces stale OUTPUT (the vector is only
  // reused for byte-identical embed-text). Flush failures are non-fatal.
  if (embeddingCache !== null && searchIndex.liveEmbeddingHashes !== undefined) {
    embeddingCache.prune(searchIndex.liveEmbeddingHashes);
    try {
      await embeddingCache.flush();
    } catch (err) {
      console.error(
        `[pipeline] Embedding cache flush failed (non-fatal): ${String(err)}`,
      );
    }
    if (verbose && searchIndex.embeddingStats.embeddingCacheHits !== undefined) {
      console.error(
        `[pipeline] Embedding cache: ${searchIndex.embeddingStats.embeddingCacheHits} hit(s), ` +
          `${searchIndex.embeddingStats.attempts} embedded`,
      );
    }
  }
  // Surface embedding failures explicitly — degraded-to-keyword items must be
  // counted, not silently swallowed (Phase C). The pipeline does NOT fail.
  if (searchIndex.embeddingStats.failures > 0) {
    console.error(
      `[pipeline] Embedding: ${searchIndex.embeddingStats.failures} of ` +
        `${searchIndex.embeddingStats.attempts} item(s) failed (null/timeout/error) — ` +
        `those degrade to keyword-only search`,
    );
  }
  if (verbose) console.error("[pipeline] Phase 6 complete: search index built");

  // Store embeddings through VectorAdapter (Req 8.4). Routes through the
  // OPTIONAL batch fast-path (indexSymbols) when the adapter implements it, and
  // falls back to per-row indexSymbol otherwise — identical data either way.
  // vectorWrites counts ROWS written (by chunk.length on the batch path).
  metrics.startPhase("persist");

  // A1 (KEYSTONE): the PERSISTED graph is keyed on the position-independent
  // `logicalKey`, while every in-memory phase (resolution/clustering/processes/
  // search) stays keyed on the intra-run `id`. Translate id → logicalKey at this
  // single persist boundary. Synthetic endpoints (import-source, `unresolved:*`,
  // `ext:*`, cluster/process ids) are NOT symbol ids, so they fall through
  // unchanged via `keyOf`.
  const idToKey = new Map<string, string>();
  for (const sym of symbols) idToKey.set(sym.id, persistedKey(sym));
  const keyOf = (id: string): string => idToKey.get(id) ?? id;

  // A4 (diff-based persistence): a DELTA write engages only when the caller
  // supplies a `delta` plan AND both adapters expose the per-file delete
  // fast-paths. Otherwise the pipeline does its historical INSERT-only write
  // (which also covers the remote/gRPC adapter — it omits the deletes, so it
  // degrades to full-refresh). The DELTA write restricts the Symbol-node and
  // vector inserts to the changed+added files (`addedAndChangedFiles`); the
  // unchanged files' rows are left in place — the incremental win. Clusters,
  // processes, external deps, and the full relationship set are always rewritten
  // wholesale (global aggregates; relationships re-MERGE idempotently, restoring
  // the inbound edges the DETACH DELETE transiently dropped). Because the merged
  // symbol+hint set is identical to a full run, the resulting graph is
  // byte-identical (delta == full).
  const deltaActive =
    effectiveDelta !== undefined &&
    typeof graphAdapter.deleteSymbolsByFilePaths === "function" &&
    typeof vectorAdapter.deleteByFilePaths === "function";

  const insertScope = deltaActive
    ? new Set(effectiveDelta!.addedAndChangedFiles)
    : null;
  const symbolsToInsert = insertScope === null
    ? symbols
    : symbols.filter((s) => insertScope.has(s.location.filePath));

  // B3 (vector streaming): an embedding is in-scope for this run's vector write
  // when no delta is active (full write) OR its file is in the changed+added
  // scope. Cluster embeddings (`cluster:<id>`) and any entry without a filePath
  // are global aggregates → always (re)written, matching the wholesale
  // cluster/process rewrite below. Kept as a predicate (not a pre-filtered copy)
  // so the vector entries are mapped+keyed LAZILY into the write helper and the
  // full `embeddings[]` array is RELEASED right after the vector write, before
  // the (separately large) node/edge prop maps are built — instead of being
  // retained through the entire persist phase. Row accounting is unchanged: the
  // in-scope COUNT below feeds countPersistRows exactly as the old filtered
  // array's length did.
  const inVectorScope = (e: EmbeddingResult): boolean => {
    if (insertScope === null) return true;
    const fp = e.metadata?.filePath;
    return fp === undefined || fp === "" || insertScope.has(fp);
  };

  // Release reference at the end of the vector write so the vectors become
  // GC-eligible before node/edge persist. `null` once consumed.
  let embeddings: EmbeddingResult[] | null = searchIndex.embeddings;
  const embeddingsToInsertCount = insertScope === null
    ? embeddings.length
    : embeddings.reduce((n, e) => (inVectorScope(e) ? n + 1 : n), 0);

  const totalPersistRows = countPersistRows(
    embeddingsToInsertCount,
    symbolsToInsert,
    relationships,
    clusters,
    processes,
    extNodes,
  );
  const persistProgress = createProgressRenderer({ verbose, label: "Indexing into LadybugDB" });
  let persistedRows = 0;
  const advancePersistProgress = (count: number): void => {
    if (totalPersistRows === 0 || count <= 0) return;
    persistedRows += count;
    persistProgress.onProgress(Math.min(persistedRows, totalPersistRows), totalPersistRows);
  };

  let embeddingCount = 0;
  try {
    // DELTA delete phase: DETACH DELETE the symbol nodes + vectors of the
    // removed+changed files BEFORE inserting. Cross-file inbound edges dropped
    // here are restored by the wholesale relationship rewrite below.
    if (deltaActive) {
      const toDelete = [...effectiveDelta!.removedAndChangedFiles];
      const symbolsDeleted = await graphAdapter.deleteSymbolsByFilePaths!(toDelete);
      const vectorsDeleted = await vectorAdapter.deleteByFilePaths!(toDelete);
      if (verbose) {
        console.error(
          `[pipeline] Delta write: deleted ${symbolsDeleted} symbol node(s) and ` +
            `${vectorsDeleted} vector(s) across ${toDelete.length} file scope(s); ` +
            `inserting ${symbolsToInsert.length} symbol(s) / ${embeddingsToInsertCount} vector(s)`,
        );
      }
    }

    // B3 (vector streaming): build the keyed, in-scope vector entries LAZILY
    // here and hand them straight to the write helper — no second persisted copy
    // is retained. Persisted vector symbolId maps to logicalKey (A1); cluster
    // vector entries (`cluster:<id>`) are synthetic and fall through unchanged.
    const vectorEntries: EmbeddingResult[] = [];
    for (const e of embeddings) {
      if (inVectorScope(e)) vectorEntries.push({ ...e, symbolId: keyOf(e.symbolId) });
    }
    // Drop the full embeddings array now that the in-scope entries are extracted,
    // so the (largest) vector payload is released before the node/edge prop maps
    // are built below — the concrete B3 peak-RSS win without changing global
    // phases or row accounting. The count was already captured above.
    embeddings = null;

    await writeVectorEntries(
      vectorAdapter,
      vectorEntries,
      (n) => {
        embeddingCount += n;
        metrics.incr("vectorWrites", n);
        advancePersistProgress(n);
      },
      {
        onBatch: () => metrics.incr("vectorBatchCount"),
        onSplit: () => metrics.incr("adaptiveSplitCount"),
        onOversized: () => metrics.incr("oversizedRowCount"),
      },
    );
    // The keyed entries are consumed; let them go before the node/edge writes.
    vectorEntries.length = 0;
    metrics.set("embeddingCount", embeddingCount);

    // Store graph data through GraphAdapter (Req 8.1). `symbolsToInsert` is the
    // changed+added subset on a delta write (full set otherwise); relationships,
    // clusters, processes, and external deps are always the full set.
    if (verbose) console.error("[pipeline] Storing results in graph database");
    await storeInDatabases(
      symbolsToInsert,
      relationships,
      clusters,
      processes,
      extNodes,
      graphAdapter,
      metrics,
      keyOf,
      advancePersistProgress,
    );

    // Write the `lastIndexed` Metadata node (A4 / pre-existing bug 0.4): `status`
    // reads `Metadata{key:'lastIndexed'}.timestamp` but nothing ever wrote it, so
    // status always reported "never". Written on BOTH full and delta paths and
    // rewritten wholesale each run (MERGE-upsert). Routed through writeNodeGroup
    // so it takes the batch fast-path when the adapter exposes one (matching how
    // every other node group is written); a no-op onRows keeps it OUT of the
    // persist-progress total and the drift-guard sum.
    await writeNodeGroup(
      graphAdapter,
      "Metadata",
      [{ id: "lastIndexed", key: "lastIndexed", timestamp: new Date().toISOString() }],
      () => {},
    );

    metrics.endPhase("persist");
    if (verbose) console.error("[pipeline] Storage complete");
  } finally {
    persistProgress.done();
  }

  // A5 (crash-safety, plan A2 decision + R2): persist the parse cache ONLY after
  // the DB write above has succeeded. If persist threw, control never reaches
  // here, so the cache is never written ahead of the DB — a crash mid-persist
  // leaves a stale-but-consistent cache that a later run re-validates by hash. A
  // cache save failure is non-fatal: the run already succeeded; the next run just
  // re-parses. `phase2.saveCache` is undefined on a full (uncached) run.
  if (phase2.saveCache) {
    try {
      await phase2.saveCache();
    } catch (err) {
      console.error(
        `[pipeline] Parse-cache save failed (non-fatal): ${String(err)}`,
      );
    }
  }

  return finishMetrics(verbose, metrics, {
    symbols,
    relationships,
    clusters,
    processes,
    externalDependencyCount: extNodes.size,
    skippedFiles,
    embeddingCount,
  });
}

/**
 * Output of {@link runPhase2}: the merged symbol/hint set plus the A5 incremental
 * bookkeeping (delta plan, next-cache saver, classification summary). On a full
 * (uncached) run `delta`, `saveCache`, and `classification` are all undefined and
 * the result is exactly today's parse output.
 */
interface Phase2Output {
  readonly symbols: Symbol[];
  readonly hints: RawRelationshipHintLike[];
  readonly skippedFiles: number;
  /** Files actually re-parsed this run (changed+added minus skips on the full path). */
  readonly filesParsed: number;
  /** A4 delta plan derived from the classify buckets (undefined on a full run). */
  readonly delta?: PipelineDelta;
  /** Saves the next parse-cache snapshot; called by the orchestrator AFTER persist
   *  succeeds. Undefined when no cache is wired. */
  readonly saveCache?: () => Promise<void>;
  /** Classify buckets, for the verbose reused/parsed report. Undefined on a full run. */
  readonly classification?: {
    readonly unchanged: readonly FileNode[];
    readonly changed: readonly FileNode[];
    readonly added: readonly FileNode[];
    readonly removed: readonly string[];
  };
}

/** Structural alias for a relationship hint as it flows through the pipeline.
 *  Both the freshly-parsed `RawRelationshipHint` and the cached
 *  `CachedRelationshipHint` assign to this under structural typing. */
type RawRelationshipHintLike = CachedFileEntry["hints"][number];

/**
 * Phase 2 with A5 incremental orchestration.
 *
 * NO CACHE / `incremental === false`: runs the historical full parse
 * (`extractAllSymbols`) over every file and returns `{symbols,hints,skippedFiles}`
 * with no delta and nothing to save — byte-identical to the pre-A5 pipeline.
 *
 * CACHE + incremental: loads the cache, CLASSIFIES the walk (changed/added/
 * unchanged/removed by content hash + PARSE_VERSION), re-parses ONLY changed+added
 * (via {@link extractAllSymbolsWithPerFile} — same slot/flatten/dedup tail, so the
 * subset's output is deterministic), then MERGES the freshly-parsed files with the
 * cached `{symbols,hints}` of the unchanged files, walking `fileNodes` in ORIGINAL
 * order so the merged arrays are byte-identical to a full parse. Per-file dedup
 * already happened at parse time; a final cross-file dedup-by-id matches the full
 * path (which dedups the whole flattened list). It derives the A4 delta plan
 * (`removedAndChangedFiles = removed ∪ changed`, `addedAndChangedFiles =
 * added ∪ changed`) and a `saveCache` closure that writes the updated manifest
 * (unchanged entries carried forward, changed+added refreshed, removed dropped).
 */
async function runPhase2(
  config: PipelineConfig,
  fileNodes: FileNode[],
  onProgress: (done: number, total: number, currentPath?: string) => void,
): Promise<Phase2Output> {
  const { sourcePath, cache } = config;
  const incremental = config.incremental ?? true;

  // Full path: no cache wired or incremental explicitly disabled (--full/--refresh).
  if (cache === undefined || !incremental) {
    const { symbols, hints, skippedFiles } = await extractAllSymbols(fileNodes, sourcePath, {
      onProgress,
    });
    return { symbols, hints, skippedFiles, filesParsed: fileNodes.length - skippedFiles };
  }

  // ── Incremental path ────────────────────────────────────────────────────────
  // The cache `load` NEVER throws (corrupt/missing → empty map → full reparse).
  const prior = await cache.load();

  // Two-tier staleness (plan 0.2): mtime is the cheap first tier, the content
  // hash is authoritative. For each walked file decide its CURRENT content hash:
  //  - has a cache entry AND its `mtimeMs` matches → the content is unchanged with
  //    high confidence; reuse the cached hash (NO read) so the classifier sees a
  //    match → `unchanged`.
  //  - no entry, or mtime differs → the file may have changed; READ it and hash
  //    the real bytes so the classifier confirms `changed` vs `unchanged`
  //    (mtime-bumped-but-content-identical → hash matches → still `unchanged`).
  // Only the mtime-suspect files are read here; the steady-state no-edit run reads
  // nothing.
  const needHash = fileNodes.filter((f) => {
    const entry = prior.get(f.path);
    return entry === undefined || entry.mtimeMs !== f.mtimeMs;
  });
  const freshContents = needHash.length > 0
    ? await readFileContents(sourcePath, needHash.map((f) => f.path))
    : new Map<string, string>();

  const currentHash = (f: FileNode): string | undefined => {
    const entry = prior.get(f.path);
    if (entry !== undefined && entry.mtimeMs === f.mtimeMs) {
      // mtime unchanged → trust the cached hash (no read).
      return entry.contentHash;
    }
    const content = freshContents.get(f.path);
    return content === undefined ? undefined : sha256Hex(content);
  };

  // Classify on the authoritative current content hash. A file with no cache
  // entry has a fresh hash that won't match any entry → `added`; a hash that
  // differs from its cached entry → `changed`; a match → `unchanged`.
  const classification = classifyFiles(
    fileNodes.map((fileNode) => ({ fileNode, contentHash: currentHash(fileNode) })),
    prior,
  );

  // Re-parse ONLY changed+added. Progress is driven across this subset; the
  // unchanged files contribute no work (their progress is implicit).
  const toParse = [...classification.changed, ...classification.added];
  const parsed = await extractAllSymbolsWithPerFile(toParse, sourcePath, { onProgress });

  // MERGE in original walk order so the flattened arrays are byte-identical to a
  // full parse: for each walked file, take the freshly-parsed slice if present,
  // else the cached slice (unchanged files). Files that were parsed but skipped
  // (parser-init/ParseError) are absent from `parsed.perFile` AND have no usable
  // cached entry for this run, so they contribute nothing — exactly as a full run.
  const mergedSymbols: Symbol[] = [];
  const mergedHints: RawRelationshipHintLike[] = [];
  // Next cache snapshot, also built in walk order (insertion order is irrelevant
  // to correctness but keeps the manifest stable across no-edit runs).
  const nextCache = new Map<string, CachedFileEntry>();

  for (const fileNode of fileNodes) {
    const fresh = parsed.perFile.get(fileNode.path);
    if (fresh !== undefined) {
      mergedSymbols.push(...fresh.symbols);
      mergedHints.push(...fresh.hints);
      nextCache.set(fileNode.path, {
        contentHash: fresh.contentHash,
        mtimeMs: fileNode.mtimeMs,
        parseVersion: PARSE_VERSION,
        symbols: fresh.symbols,
        hints: fresh.hints,
      });
      continue;
    }
    // Not freshly parsed → reuse the cached entry if this file is `unchanged`.
    // (A `changed`/`added` file that was parsed-but-skipped lands here with no
    // entry — skip it, matching the full path which also drops skipped files.)
    const cached = prior.get(fileNode.path);
    if (cached !== undefined && cached.parseVersion === PARSE_VERSION) {
      mergedSymbols.push(...cached.symbols);
      mergedHints.push(...cached.hints);
      nextCache.set(fileNode.path, cached);
    }
  }

  // Match the full path's whole-list dedup-by-id (per-file dedup already ran).
  const dedupedSymbols = dedupeById(mergedSymbols);

  // A4 delta plan: delete the existing rows of removed+changed files, insert the
  // rows of added+changed files. Unchanged files' rows are left in place.
  const delta: PipelineDelta = {
    removedAndChangedFiles: [...classification.removed, ...classification.changed.map((f) => f.path)],
    addedAndChangedFiles: [...classification.changed, ...classification.added].map((f) => f.path),
  };

  const saveCache = async (): Promise<void> => {
    await cache.save(nextCache);
  };

  return {
    symbols: dedupedSymbols,
    hints: mergedHints,
    skippedFiles: parsed.skippedFiles,
    filesParsed: toParse.length - parsed.skippedFiles,
    delta,
    saveCache,
    classification,
  };
}

/** Cross-file dedup by `id`, preserving first-seen order — mirrors the parse
 *  layer's own `deduplicateById` so the merged set matches a full parse. */
function dedupeById(symbols: readonly Symbol[]): Symbol[] {
  const seen = new Set<string>();
  const result: Symbol[] = [];
  for (const sym of symbols) {
    if (!seen.has(sym.id)) {
      seen.add(sym.id);
      result.push(sym);
    }
  }
  return result;
}

/**
 * A5 public API — re-index a known set of changed file paths.
 *
 * This is the seam Workstream C (watch mode / CI `detect_changes`) builds on:
 * given the paths git/the watcher reports as changed, run the SAME incremental
 * pipeline. It does NOT trust the caller's list as the delta — it simply runs the
 * normal incremental pipeline (`incremental: true` + the supplied cache), which
 * re-walks, re-classifies against the parse cache, and converges on the correct
 * delta regardless of what the caller passed. So a caller that over- or
 * under-reports still produces a correct, byte-identical graph; the `paths`
 * argument is an OPTIMISATION HINT for callers (and a stable signature for C),
 * not a trusted authority.
 *
 * `paths` is currently advisory (logged in verbose mode); the classify step is
 * the source of truth. Kept in the signature so watch/CI callers have a stable
 * entry point and a future fast-path (skip the full walk for tiny change sets)
 * can use it without an API change.
 *
 * Requires `config.cache` to be set (otherwise it degrades to a full run, which
 * is still correct). Returns the same {@link PipelineResult} as
 * {@link runIndexingPipeline}.
 */
export async function reindexChangedFiles(
  paths: readonly string[],
  config: PipelineConfig,
): Promise<PipelineResult> {
  if (config.verbose) {
    console.error(
      `[pipeline] reindexChangedFiles: ${paths.length} hinted path(s); ` +
        `classify step is authoritative`,
    );
  }
  return runIndexingPipeline({ ...config, incremental: true });
}

/**
 * Finalize the metrics snapshot, attach it to the result, and emit a verbose
 * throughput summary on stderr when requested. Non-verbose output is unchanged.
 */
function finishMetrics(
  verbose: boolean,
  collector: ReturnType<typeof createMetricsCollector>,
  result: Omit<PipelineResult, "metrics">,
): PipelineResult {
  const metrics = collector.finalize();
  if (verbose) console.error(formatMetrics(metrics));
  return { ...result, metrics };
}

/**
 * Compute the total number of rows the persist phase will write: vector entries
 * plus graph nodes (symbols + clusters + processes + external deps) plus graph
 * edges (relationships + CONTAINS cluster-membership + HAS_STEP process-step).
 *
 * This MUST stay in lockstep with what {@link storeInDatabases} actually writes
 * (and with the vector write count). If they drift, the persist progress bar
 * stops short of / overshoots 100% and metrics desync. The drift-guard test in
 * pipeline.test.ts asserts `sum(onRows) === countPersistRows(...)`, so any change
 * to write shape that is not mirrored here fails loudly. Exported for that test.
 *
 * On a DELTA write (A4) the caller passes the INSERTED subset (`symbolsToInsert`
 * / `embeddingsToInsert` — the changed+added files only) for `symbols` and
 * `vectorEntries`, while `relationships`/`clusters`/`processes`/`extNodes` stay
 * the full set (rewritten wholesale). The per-file DELETEs and the wholesale
 * `lastIndexed` Metadata upsert are NOT counted here — neither flows through the
 * `onRows` persist-progress path, so the drift-guard total excludes them.
 */
/**
 * E3: fold `member.access` hints into each consumer symbol's `accessedKeys`.
 *
 * Each `access` hint records a `recv.prop` property read attributed (via its
 * `enclosingSymbolId`, the consumer's intra-run `id`) to the function/method it
 * sits in. We group the read property keys by that enclosing id and attach them
 * (de-duplicated, first-seen order) to the matching symbol as `accessedKeys`.
 *
 * Purely ADDITIVE: symbols with no attributed reads are returned unchanged
 * (same object identity), so the resolution/clustering/persist phases produce a
 * byte-identical graph apart from the new optional Symbol prop. Module-top-level
 * reads (no enclosing definition) are dropped in v1.
 */
function attachAccessedKeys(
  symbols: readonly Symbol[],
  hints: readonly RawRelationshipHintLike[],
): Symbol[] {
  const keysById = new Map<string, string[]>();
  const seenById = new Map<string, Set<string>>();
  for (const hint of hints) {
    if (hint.kind !== "access") continue;
    const ownerId = hint.enclosingSymbolId;
    if (!ownerId) continue;
    const key = hint.targetName;
    if (!key) continue;
    let seen = seenById.get(ownerId);
    if (!seen) {
      seen = new Set<string>();
      seenById.set(ownerId, seen);
      keysById.set(ownerId, []);
    }
    if (!seen.has(key)) {
      seen.add(key);
      keysById.get(ownerId)!.push(key);
    }
  }
  if (keysById.size === 0) return symbols as Symbol[];
  return symbols.map((s) => {
    const keys = keysById.get(s.id);
    return keys && keys.length > 0 ? { ...s, accessedKeys: keys } : s;
  });
}

export function countPersistRows(
  vectorEntries: number,
  symbols: readonly Symbol[],
  relationships: readonly Relationship[],
  clusters: readonly Cluster[],
  processes: readonly Process[],
  extNodes: ReadonlyMap<string, ExternalDependencyNode>,
): number {
  const nodeRows = symbols.length + clusters.length + processes.length + extNodes.size;
  const clusterEdges = clusters.reduce((total, cluster) => total + cluster.symbols.length, 0);
  const processEdges = processes.reduce((total, process) => total + process.steps.length, 0);
  return vectorEntries + nodeRows + relationships.length + clusterEdges + processEdges;
}

/**
 * Store pipeline results through GraphAdapter.
 *
 * Writes are grouped by node label (Symbol/Cluster/Process/ExternalDependency)
 * and by relationship type (the mapped `relType`, CONTAINS, HAS_STEP), then
 * routed through {@link writeNodeGroup} / {@link writeRelationshipGroup}. Those
 * helpers use the OPTIONAL batch fast-path (createNodes/createRelationships)
 * when the adapter implements it, and fall back to per-row createNode/
 * createRelationship otherwise — identical data and grouping either way.
 *
 * The PR1 metric counts (graphNodeWrites/graphEdgeWrites) count ROWS written,
 * not batch calls: the helpers report the rows-per-step via the `onRows`
 * callback, which increments by `chunk.length` on the batch path.
 *
 * Requirements: 3.8, 8.1
 */
async function storeInDatabases(
  symbols: Symbol[],
  relationships: Relationship[],
  clusters: Cluster[],
  processes: Process[],
  extNodes: Map<string, ExternalDependencyNode>,
  graphAdapter: GraphAdapter,
  metrics: ReturnType<typeof createMetricsCollector>,
  // A1: maps an intra-run `id` endpoint to its persisted `logicalKey`. Non-symbol
  // (synthetic) endpoints fall through unchanged.
  keyOf: (id: string) => string,
  onRows?: (count: number) => void,
): Promise<void> {
  // NOTE: Do NOT prepend prefix here — the GraphAdapter handles prefixing internally.
  const countNodes = (n: number): void => {
    metrics.incr("graphNodeWrites", n);
    onRows?.(n);
  };
  const countEdges = (n: number): void => {
    metrics.incr("graphEdgeWrites", n);
    onRows?.(n);
  };

  // Batch-level events (Phase B). Split/oversized are entity-agnostic; the batch
  // counter is entity-specific (node vs relationship). These count CALLS/events,
  // never rows — onRows above stays row-accurate.
  const nodeEvents = {
    onBatch: (): void => metrics.incr("nodeBatchCount"),
    onSplit: (): void => metrics.incr("adaptiveSplitCount"),
    onOversized: (): void => metrics.incr("oversizedRowCount"),
  };
  const relationshipEvents = {
    onBatch: (): void => metrics.incr("relationshipBatchCount"),
    onSplit: (): void => metrics.incr("adaptiveSplitCount"),
    onOversized: (): void => metrics.incr("oversizedRowCount"),
  };

  // ── Node groups (one label each) ──────────────────────────────────────────
  await writeNodeGroup(
    graphAdapter,
    "Symbol",
    symbols.map((s) => ({
      id: persistedKey(s),
      name: s.name,
      kind: s.kind,
      filePath: s.location.filePath,
      startLine: String(s.location.startLine),
      endLine: String(s.location.endLine),
      visibility: s.visibility,
      signature: s.signature ?? "",
      documentation: s.documentation ?? "",
      // E2: complexity metrics persisted as STRINGS (matching the startLine
      // convention) so they are queryable via `toInteger(s.cyclomatic)`. Absent
      // metrics default to "0" — countPersistRows is unaffected (props, not rows).
      cyclomatic: String(s.complexity?.cyclomatic ?? 0),
      cognitive: String(s.complexity?.cognitive ?? 0),
      maxLoopDepth: String(s.complexity?.maxLoopDepth ?? 0),
      // E3: route response shape + consumer-read keys persisted as JSON STRING
      // props (queried back by `shape_check`). Empty arrays default to "[]" —
      // countPersistRows is unaffected (props, not rows).
      responseKeys: JSON.stringify(s.responseKeys ?? []),
      accessedKeys: JSON.stringify(s.accessedKeys ?? []),
      // Wave 2: export flag + entry-point classification props (string, empty
      // when absent). countPersistRows is unaffected (props, not rows).
      // Tri-state isExported: persist "" when the export checker abstained
      // (undefined) so the read side leaves it undefined and the
      // `isExported ?? visibility` fallback still fires — never collapse to "false".
      isExported: s.isExported === undefined ? "" : s.isExported ? "true" : "false",
      entryPointKind: s.entryPointKind ?? "",
      entryPointReason: s.entryPointReason ?? "",
    })),
    countNodes,
    nodeEvents,
  );

  await writeNodeGroup(
    graphAdapter,
    "Cluster",
    clusters.map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      confidence: String(c.confidence),
      symbolCount: String(c.symbols.length),
    })),
    countNodes,
    nodeEvents,
  );

  await writeNodeGroup(
    graphAdapter,
    "Process",
    processes.map((p) => ({
      id: p.id,
      name: p.name,
      entryPoint: keyOf(p.entryPoint),
      stepCount: String(p.steps.length),
    })),
    countNodes,
    nodeEvents,
  );

  await writeNodeGroup(
    graphAdapter,
    "ExternalDependency",
    [...extNodes.values()].map((extNode) => ({
      id: extNode.id,
      name: extNode.name,
      aliases: extNode.aliases.join(","),
      ecosystem: extNode.ecosystem,
    })),
    countNodes,
    nodeEvents,
  );

  // ── Relationship groups (one type each) ─────────────────────────────────────
  // Resolved relationships carry mixed relTypes; group by the SAME mapping used
  // by the per-row path ("dependsOn" → "DEPENDS_ON", else relType.toUpperCase())
  // so each batch call sees a single type, preserving insertion order per type.
  const edgesByType = new Map<string, RelationshipRow[]>();
  for (const r of relationships) {
    const type = r.relType === "dependsOn" ? "DEPENDS_ON" : r.relType.toUpperCase();
    const rows = edgesByType.get(type) ?? [];
    rows.push({ fromId: keyOf(r.source), toId: keyOf(r.target), properties: r.metadata });
    edgesByType.set(type, rows);
  }
  for (const [type, rows] of edgesByType) {
    await writeRelationshipGroup(graphAdapter, type, rows, countEdges, relationshipEvents);
  }

  // Cluster membership edges (cluster → symbol).
  await writeRelationshipGroup(
    graphAdapter,
    "CONTAINS",
    clusters.flatMap((c) => c.symbols.map((symbolId) => ({ fromId: c.id, toId: keyOf(symbolId), properties: {} }))),
    countEdges,
    relationshipEvents,
  );

  // Process step edges (process → symbol), with step_order metadata.
  await writeRelationshipGroup(
    graphAdapter,
    "HAS_STEP",
    processes.flatMap((p) =>
      p.steps.map((step) => ({
        fromId: p.id,
        toId: keyOf(step.symbolId),
        properties: { step_order: String(step.order) },
      })),
    ),
    countEdges,
    relationshipEvents,
  );
}
