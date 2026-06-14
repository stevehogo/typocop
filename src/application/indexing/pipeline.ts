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
import type { DatabaseAdapter, GraphAdapter, VectorAdapter, EmbeddingAdapter } from "../../core/ports/persistence.js";
import { walkFileTree, type FileNode } from "./structure/index.js";
import { extractAllSymbols } from "./parsing/index.js";
import { resolveReferences } from "./resolution/index.js";
import { clusterSymbols, type AIClient } from "./clustering/index.js";
import { traceProcesses } from "./processes/index.js";
import { buildSearchIndex } from "./search/index.js";
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
 * Requirements: 8.1
 */
export interface PipelineConfig {
  readonly sourcePath: string;
  readonly language: Language;
  readonly verbose: boolean;
  readonly adapter: DatabaseAdapter;
  readonly aiClient?: AIClient;
  readonly semanticClassification?: boolean;
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
  const progress = createProgressRenderer({ verbose, label: "Phase 2: parsing" });
  const { symbols, hints, skippedFiles } = await metrics.time("parsing", () =>
    extractAllSymbols(fileNodes, sourcePath, { onProgress: progress.onProgress }),
  );
  progress.done();
  metrics.set("skippedFiles", skippedFiles);
  metrics.set("filesParsed", fileNodes.length - skippedFiles);
  metrics.set("symbolCount", symbols.length);
  metrics.set("hintCount", hints.length);
  if (verbose) console.error(`[pipeline] Phase 2 complete: ${symbols.length} symbols extracted, ${hints.length} relationship hints`);

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
  const { relationships, extNodes, dependsOnStats } = await metrics.time("resolution", () =>
    resolveReferences(symbols, hints, sourcePath),
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
  metrics.endPhase("processes");
  metrics.set("processCount", processes.length);
  if (verbose) console.error(`[pipeline] Phase 5 complete: ${processes.length} processes traced`);

  if (verbose) console.error("[pipeline] Starting Phase 6: Search indexing");

  // Phase 6: Build search index and generate embeddings (Req 3.6, 8.2–8.5)
  let embedFn: ((text: string) => Promise<Embedding | null>) | null = null;

  if (embeddingAdapter.isEnabled()) {
    embedFn = (text: string) => embeddingAdapter.embedText(text);
  } else {
    console.error("[pipeline] Embeddings disabled — skipping embedding generation");
  }

  // Keyword indexing always runs regardless of embedding state (Req 8.5).
  // Embedding generation is the bulk of the search phase cost, so attribute the
  // whole phase to embeddingElapsedMs (finer per-call granularity lives in the
  // search module; phase timing is acceptable here per Phase A).
  const searchStart = performance.now();
  const searchIndex = await metrics.time("search", () => buildSearchIndex(symbols, clusters, embedFn));
  metrics.addElapsed("embeddingElapsedMs", performance.now() - searchStart);
  metrics.set("embeddingAttempts", searchIndex.embeddingStats.attempts);
  metrics.set("embeddingFailures", searchIndex.embeddingStats.failures);
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
  let embeddingCount = 0;
  await writeVectorEntries(vectorAdapter, searchIndex.embeddings, (n) => {
    embeddingCount += n;
    metrics.incr("vectorWrites", n);
  });
  metrics.set("embeddingCount", embeddingCount);

  // Store graph data through GraphAdapter (Req 8.1)
  if (verbose) console.error("[pipeline] Storing results in graph database");
  await storeInDatabases(symbols, relationships, clusters, processes, extNodes, graphAdapter, metrics);
  metrics.endPhase("persist");
  if (verbose) console.error("[pipeline] Storage complete");

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
): Promise<void> {
  // NOTE: Do NOT prepend prefix here — the GraphAdapter handles prefixing internally.
  const countNodes = (n: number) => metrics.incr("graphNodeWrites", n);
  const countEdges = (n: number) => metrics.incr("graphEdgeWrites", n);

  // ── Node groups (one label each) ──────────────────────────────────────────
  await writeNodeGroup(
    graphAdapter,
    "Symbol",
    symbols.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      filePath: s.location.filePath,
      startLine: String(s.location.startLine),
      endLine: String(s.location.endLine),
      visibility: s.visibility,
      signature: s.signature ?? "",
      documentation: s.documentation ?? "",
    })),
    countNodes,
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
  );

  await writeNodeGroup(
    graphAdapter,
    "Process",
    processes.map((p) => ({
      id: p.id,
      name: p.name,
      entryPoint: p.entryPoint,
      stepCount: String(p.steps.length),
    })),
    countNodes,
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
  );

  // ── Relationship groups (one type each) ─────────────────────────────────────
  // Resolved relationships carry mixed relTypes; group by the SAME mapping used
  // by the per-row path ("dependsOn" → "DEPENDS_ON", else relType.toUpperCase())
  // so each batch call sees a single type, preserving insertion order per type.
  const edgesByType = new Map<string, RelationshipRow[]>();
  for (const r of relationships) {
    const type = r.relType === "dependsOn" ? "DEPENDS_ON" : r.relType.toUpperCase();
    const rows = edgesByType.get(type) ?? [];
    rows.push({ fromId: r.source, toId: r.target, properties: r.metadata });
    edgesByType.set(type, rows);
  }
  for (const [type, rows] of edgesByType) {
    await writeRelationshipGroup(graphAdapter, type, rows, countEdges);
  }

  // Cluster membership edges (cluster → symbol).
  await writeRelationshipGroup(
    graphAdapter,
    "CONTAINS",
    clusters.flatMap((c) => c.symbols.map((symbolId) => ({ fromId: c.id, toId: symbolId, properties: {} }))),
    countEdges,
  );

  // Process step edges (process → symbol), with step_order metadata.
  await writeRelationshipGroup(
    graphAdapter,
    "HAS_STEP",
    processes.flatMap((p) =>
      p.steps.map((step) => ({
        fromId: p.id,
        toId: step.symbolId,
        properties: { step_order: String(step.order) },
      })),
    ),
    countEdges,
  );
}
