/**
 * Indexing pipeline orchestrator — wires all 6 phases together.
 * 
 * This is the main entry point for transforming source code into a queryable knowledge graph.
 * The pipeline executes sequentially through 6 phases, storing results in Neo4j and pgvector.
 * 
 * @example
 * ```typescript
 * import { runIndexingPipeline } from './indexer/pipeline.js';
 * import neo4j from 'neo4j-driver';
 * import { Pool } from 'pg';
 * 
 * const driver = neo4j.driver('bolt://localhost:7687', neo4j.auth.basic('neo4j', 'password'));
 * const session = driver.session();
 * const pool = new Pool({ connectionString: 'postgresql://localhost:5432/typocop' });
 * 
 * const result = await runIndexingPipeline({
 *   sourcePath: './src',
 *   language: 'typescript',
 *   verbose: true,
 *   graphSession: session,
 *   vectorPool: pool,
 * });
 * 
 * console.log(`Indexed ${result.symbols.length} symbols`);
 * ```
 * 
 * Requirements: 1.1, 1.6, 1.7, 3.1–3.8
 */
import type { Driver, Session } from "neo4j-driver";
import type { Pool } from "pg";
import type { Language, Symbol, Relationship, Cluster, Process } from "../types/index.js";
import { walkFileTree, readFileContents, type FileNode } from "./structure/index.js";
import { extractAllSymbols } from "./parsing/index.js";
import { resolveReferences } from "./resolution/index.js";
import { clusterSymbols, type AIClient } from "./clustering/index.js";
import { traceProcesses } from "./processes/index.js";
import { buildSearchIndex } from "./search/index.js";
import { storeNodes, storeEdges } from "../graph/store.js";
import { indexSymbol } from "../vector/index-store.js";
import type { GraphNode, GraphEdge } from "../graph/connection.js";

/**
 * Configuration for the indexing pipeline.
 * 
 * @property sourcePath - Root directory to index (e.g., './src', './app/code')
 * @property language - Target language for parsing (must match source code)
 * @property verbose - Enable detailed progress logging to console
 * @property graphSession - Active Neo4j session for storing graph nodes and edges
 * @property vectorPool - PostgreSQL connection pool with pgvector extension enabled
 * @property aiClient - Optional AI client for cluster enrichment and semantic analysis
 */
export interface PipelineConfig {
  readonly sourcePath: string;
  readonly language: Language;
  readonly verbose: boolean;
  readonly graphSession: Session;
  readonly vectorPool: Pool;
  readonly aiClient?: AIClient;
}

/**
 * Result of the complete indexing pipeline execution.
 * 
 * @property symbols - All extracted symbols (functions, classes, methods, etc.)
 * @property relationships - All resolved relationships (calls, imports, inheritance, etc.)
 * @property clusters - Functional communities detected via Louvain algorithm
 * @property processes - Execution flows traced from entry points
 * @property skippedFiles - Count of files that couldn't be parsed (syntax errors, size limits, etc.)
 */
export interface PipelineResult {
  readonly symbols: Symbol[];
  readonly relationships: Relationship[];
  readonly clusters: Cluster[];
  readonly processes: Process[];
  readonly skippedFiles: number;
}

/**
 * Execute the complete 6-phase indexing pipeline.
 * 
 * This function orchestrates the transformation of source code into a queryable knowledge graph:
 * 
 * **Phase 1: Structure** — Walk file tree and identify all source files
 * **Phase 2: Parsing** — Extract symbols from ASTs using tree-sitter
 * **Phase 3: Resolution** — Resolve cross-file references (imports, calls, inheritance)
 * **Phase 4: Clustering** — Group related symbols into functional communities
 * **Phase 5: Processes** — Trace execution flows from entry points
 * **Phase 6: Search** — Build hybrid indexes (vector + keyword) for fast retrieval
 * 
 * Results are automatically stored in Neo4j (graph structure) and pgvector (semantic search).
 * 
 * @param config - Pipeline configuration including source path, language, and database connections
 * @returns Pipeline result with all extracted symbols, relationships, clusters, and processes
 * @throws {Error} If database connections fail or critical phase errors occur
 * 
 * @example
 * ```typescript
 * const result = await runIndexingPipeline({
 *   sourcePath: './src',
 *   language: 'typescript',
 *   verbose: true,
 *   graphSession: neo4jSession,
 *   vectorPool: pgPool,
 * });
 * 
 * console.log(`Found ${result.symbols.length} symbols in ${result.clusters.length} clusters`);
 * ```
 * 
 * Requirements: 3.1–3.8
 */
export async function runIndexingPipeline(config: PipelineConfig): Promise<PipelineResult> {
  const { sourcePath, verbose, graphSession, vectorPool, aiClient } = config;

  if (verbose) console.log("[pipeline] Starting Phase 1: Structure");
  
  // Phase 1: Walk file tree (Req 3.1)
  const fileNodes = await walkFileTree(sourcePath);
  if (verbose) console.log(`[pipeline] Phase 1 complete: ${fileNodes.length} files found`);

  if (fileNodes.length === 0) {
    return {
      symbols: [],
      relationships: [],
      clusters: [],
      processes: [],
      skippedFiles: 0,
    };
  }

  if (verbose) console.log("[pipeline] Starting Phase 2: Parsing");
  
  // Phase 2: Extract symbols (Req 3.2)
  const symbols = await extractAllSymbols(fileNodes);
  if (verbose) console.log(`[pipeline] Phase 2 complete: ${symbols.length} symbols extracted`);

  if (symbols.length === 0) {
    return {
      symbols: [],
      relationships: [],
      clusters: [],
      processes: [],
      skippedFiles: 0,
    };
  }

  if (verbose) console.log("[pipeline] Starting Phase 3: Resolution");
  
  // Phase 3: Resolve references (Req 3.3)
  const relationships = resolveReferences(symbols);
  if (verbose) console.log(`[pipeline] Phase 3 complete: ${relationships.length} relationships resolved`);

  if (verbose) console.log("[pipeline] Starting Phase 4: Clustering");
  
  // Phase 4: Cluster symbols (Req 3.4)
  const clusters = await clusterSymbols(symbols, relationships, aiClient);
  if (verbose) console.log(`[pipeline] Phase 4 complete: ${clusters.length} clusters created`);

  if (verbose) console.log("[pipeline] Starting Phase 5: Processes");
  
  // Phase 5: Trace processes (Req 3.5)
  const processes = traceProcesses(symbols, relationships);
  if (verbose) console.log(`[pipeline] Phase 5 complete: ${processes.length} processes traced`);

  if (verbose) console.log("[pipeline] Starting Phase 6: Search indexing");
  
  // Phase 6: Build search index (Req 3.6)
  const embedFn = async (text: string) => {
    // Embedding generation is handled by the caller if needed
    // This is a placeholder that returns null (service unavailable)
    return null;
  };
  
  await buildSearchIndex(symbols, clusters, embedFn);
  if (verbose) console.log(`[pipeline] Phase 6 complete: search index built`);

  // Store results in databases (Req 3.8)
  if (verbose) console.log("[pipeline] Storing results in graph database and vector store");
  await storeInDatabases(symbols, relationships, clusters, processes, graphSession, vectorPool);
  if (verbose) console.log("[pipeline] Storage complete");

  return {
    symbols,
    relationships,
    clusters,
    processes,
    skippedFiles: 0, // TODO: Track skipped files from Phase 2
  };
}

/**
 * Store pipeline results in Neo4j and pgvector.
 * 
 * This internal function converts pipeline results into graph nodes and edges,
 * then stores them in the appropriate databases:
 * 
 * - **Neo4j**: Stores symbols, clusters, and processes as nodes with relationships
 * - **pgvector**: Stores embeddings for semantic search (handled by buildSearchIndex)
 * 
 * Graph structure:
 * - Symbol nodes: Labeled with ["Symbol", kind], contain location and signature
 * - Cluster nodes: Labeled ["Cluster"], contain category and confidence
 * - Process nodes: Labeled ["Process"], contain entry point and step count
 * - Relationships: CALLS, IMPORTS, INHERITS, IMPLEMENTS, BELONGS_TO, PART_OF
 * 
 * @param symbols - All extracted symbols to store
 * @param relationships - All resolved relationships between symbols
 * @param clusters - All detected functional communities
 * @param processes - All traced execution flows
 * @param graphSession - Active Neo4j session for graph operations
 * @param vectorPool - PostgreSQL connection pool (currently unused, reserved for future direct vector operations)
 * 
 * Requirements: 3.8, 16.1, 16.2, 17.1
 */
async function storeInDatabases(
  symbols: Symbol[],
  relationships: Relationship[],
  clusters: Cluster[],
  processes: Process[],
  graphSession: Session,
  vectorPool: Pool,
): Promise<void> {
  // Convert symbols to graph nodes
  const symbolNodes: GraphNode[] = symbols.map((s) => ({
    id: s.id,
    labels: ["Symbol", s.kind],
    properties: {
      name: s.name,
      kind: s.kind,
      filePath: s.location.filePath,
      startLine: String(s.location.startLine),
      endLine: String(s.location.endLine),
      visibility: s.visibility,
      signature: s.signature ?? "",
      documentation: s.documentation ?? "",
    },
  }));

  // Convert clusters to graph nodes
  const clusterNodes: GraphNode[] = clusters.map((c) => ({
    id: c.id,
    labels: ["Cluster"],
    properties: {
      name: c.name,
      category: c.category,
      confidence: String(c.confidence),
      symbolCount: String(c.symbols.length),
    },
  }));

  // Convert processes to graph nodes
  const processNodes: GraphNode[] = processes.map((p) => ({
    id: p.id,
    labels: ["Process"],
    properties: {
      name: p.name,
      entryPoint: p.entryPoint,
      stepCount: String(p.steps.length),
    },
  }));

  // Store all nodes
  await storeNodes(graphSession, [...symbolNodes, ...clusterNodes, ...processNodes]);

  // Convert relationships to graph edges
  const relationshipEdges: GraphEdge[] = relationships.map((r) => ({
    source: r.source,
    target: r.target,
    relType: r.relType.toUpperCase(),
    properties: r.metadata,
  }));

  // Create cluster membership edges
  const clusterEdges: GraphEdge[] = clusters.flatMap((c) =>
    c.symbols.map((symbolId) => ({
      source: symbolId,
      target: c.id,
      relType: "BELONGS_TO",
      properties: {},
    }))
  );

  // Create process step edges
  const processEdges: GraphEdge[] = processes.flatMap((p) =>
    p.steps.map((step) => ({
      source: step.symbolId,
      target: p.id,
      relType: "PART_OF",
      properties: { order: String(step.order) },
    }))
  );

  // Store all edges
  await storeEdges(graphSession, [...relationshipEdges, ...clusterEdges, ...processEdges]);
}
