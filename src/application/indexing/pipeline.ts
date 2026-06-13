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

/**
 * Configuration for the indexing pipeline.
 *
 * @property sourcePath - Root directory to index
 * @property language - Target language for parsing
 * @property verbose - Enable detailed progress logging
 * @property adapter - DatabaseAdapter providing graph, vector, and embedding access
 * @property aiClient - Optional AI client for cluster enrichment
 *
 * Requirements: 8.1
 */
export interface PipelineConfig {
  readonly sourcePath: string;
  readonly language: Language;
  readonly verbose: boolean;
  readonly adapter: DatabaseAdapter;
  readonly aiClient?: AIClient;
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
}

/**
 * Execute the complete 6-phase indexing pipeline.
 *
 * Requirements: 3.1–3.8, 8.1–8.5
 */
export async function runIndexingPipeline(config: PipelineConfig): Promise<PipelineResult> {
  const { sourcePath, verbose, adapter, aiClient } = config;
  const graphAdapter = adapter.getGraphAdapter();
  const vectorAdapter = adapter.getVectorAdapter();
  const embeddingAdapter = adapter.getEmbeddingAdapter();

  if (verbose) console.error("[pipeline] Starting Phase 1: Structure");

  // Phase 1: Walk file tree (Req 3.1)
  const fileNodes = await walkFileTree(sourcePath);
  if (verbose) console.error(`[pipeline] Phase 1 complete: ${fileNodes.length} files found`);

  if (fileNodes.length === 0) {
    return {
      symbols: [],
      relationships: [],
      clusters: [],
      processes: [],
      externalDependencyCount: 0,
      skippedFiles: 0,
      embeddingCount: 0,
    };
  }

  if (verbose) console.error("[pipeline] Starting Phase 2: Parsing");

  // Phase 2: Extract symbols and relationship hints (Req 3.2)
  const { symbols, hints, skippedFiles } = await extractAllSymbols(fileNodes, sourcePath);
  if (verbose) console.error(`[pipeline] Phase 2 complete: ${symbols.length} symbols extracted, ${hints.length} relationship hints`);

  if (symbols.length === 0) {
    return {
      symbols: [],
      relationships: [],
      clusters: [],
      processes: [],
      externalDependencyCount: 0,
      skippedFiles,
      embeddingCount: 0,
    };
  }

  if (verbose) console.error("[pipeline] Starting Phase 3: Resolution");

  // Phase 3: Resolve references (Req 3.3)
  const { relationships, extNodes } = await resolveReferences(symbols, hints, sourcePath);
  if (verbose) console.error(`[pipeline] Phase 3 complete: ${relationships.length} relationships resolved`);

  if (verbose) console.error("[pipeline] Starting Phase 4: Clustering");

  // Phase 4: Cluster symbols (Req 3.4)
  const clusters = await clusterSymbols(symbols, relationships, aiClient, embeddingAdapter);
  if (verbose) console.error(`[pipeline] Phase 4 complete: ${clusters.length} clusters created`);

  if (verbose) console.error("[pipeline] Starting Phase 5: Processes");

  // Phase 5: Trace processes (Req 3.5)
  const processes = traceProcesses(symbols, relationships);
  if (verbose) console.error(`[pipeline] Phase 5 complete: ${processes.length} processes traced`);

  if (verbose) console.error("[pipeline] Starting Phase 6: Search indexing");

  // Phase 6: Build search index and generate embeddings (Req 3.6, 8.2–8.5)
  let embedFn: ((text: string) => Promise<Embedding | null>) | null = null;

  if (embeddingAdapter.isEnabled()) {
    embedFn = (text: string) => embeddingAdapter.embedText(text);
  } else {
    console.error("[pipeline] Embeddings disabled — skipping embedding generation");
  }

  // Keyword indexing always runs regardless of embedding state (Req 8.5)
  const searchIndex = await buildSearchIndex(symbols, clusters, embedFn);
  if (verbose) console.error("[pipeline] Phase 6 complete: search index built");

  // Store embeddings through VectorAdapter (Req 8.4)
  let embeddingCount = 0;
  for (const result of searchIndex.embeddings) {
    await vectorAdapter.indexSymbol(result.symbolId, result.embedding, result.metadata);
    embeddingCount++;
  }

  // Store graph data through GraphAdapter (Req 8.1)
  if (verbose) console.error("[pipeline] Storing results in graph database");
  await storeInDatabases(symbols, relationships, clusters, processes, extNodes, graphAdapter);
  if (verbose) console.error("[pipeline] Storage complete");

  return {
    symbols,
    relationships,
    clusters,
    processes,
    externalDependencyCount: extNodes.size,
    skippedFiles,
    embeddingCount,
  };
}

/**
 * Store pipeline results through GraphAdapter.
 *
 * Iterates over each node and edge, calling GraphAdapter methods individually
 * instead of batch storeNodes/storeEdges.
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
): Promise<void> {
  // NOTE: Do NOT prepend prefix here — the GraphAdapter handles prefixing internally.

  // Store symbol nodes
  for (const s of symbols) {
    await graphAdapter.createNode("Symbol", {
      id: s.id,
      name: s.name,
      kind: s.kind,
      filePath: s.location.filePath,
      startLine: String(s.location.startLine),
      endLine: String(s.location.endLine),
      visibility: s.visibility,
      signature: s.signature ?? "",
      documentation: s.documentation ?? "",
    });
  }

  // Store cluster nodes
  for (const c of clusters) {
    await graphAdapter.createNode("Cluster", {
      id: c.id,
      name: c.name,
      category: c.category,
      confidence: String(c.confidence),
      symbolCount: String(c.symbols.length),
    });
  }

  // Store process nodes
  for (const p of processes) {
    await graphAdapter.createNode("Process", {
      id: p.id,
      name: p.name,
      entryPoint: p.entryPoint,
      stepCount: String(p.steps.length),
    });
  }

  for (const extNode of extNodes.values()) {
    await graphAdapter.createNode("ExternalDependency", {
      id: extNode.id,
      name: extNode.name,
      aliases: extNode.aliases.join(","),
      ecosystem: extNode.ecosystem,
    });
  }

  // Store relationship edges
  for (const r of relationships) {
    await graphAdapter.createRelationship(
      r.source,
      r.target,
      r.relType === "dependsOn" ? "DEPENDS_ON" : r.relType.toUpperCase(),
      r.metadata,
    );
  }

  // Store cluster membership edges (cluster → symbol)
  for (const c of clusters) {
    for (const symbolId of c.symbols) {
      await graphAdapter.createRelationship(c.id, symbolId, "CONTAINS", {});
    }
  }

  // Store process step edges (process → symbol)
  for (const p of processes) {
    for (const step of p.steps) {
      await graphAdapter.createRelationship(
        p.id,
        step.symbolId,
        "HAS_STEP",
        { step_order: String(step.order) },
      );
    }
  }
}
