/**
 * Smart search query implementation.
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 22.3, 7.3, 7.4
 */
import type { GraphAdapter, VectorAdapter, EmbeddingAdapter } from "../core/ports/persistence.js";
import type { Symbol, Cluster, Process, SearchResult } from "../core/domain.js";
import { preprocessQuery } from "./preprocess.js";

// ─── Graph query helpers using GraphAdapter ───────────────────────────────────

interface CypherClusterRow {
  id: string;
  name: string;
  symbols: string[];
  confidence: string;
  category: string;
}

interface CypherProcessRow {
  id: string;
  name: string;
  entryPoint: string;
  steps: Array<{ order: number; symbolId: string; description: string }>;
  dataFlow: Array<{ from: string; to: string; dataType?: string }>;
}

interface CypherSymbolRow {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: string;
  startColumn: string;
  endLine: string;
  endColumn: string;
  signature: string | undefined;
  documentation: string | undefined;
  visibility: string;
  modifiers: string[];
}

/**
 * Fetch clusters containing the given symbol IDs.
 * Requirements: 11.2
 */
async function fetchClustersForSymbols(
  graphAdapter: GraphAdapter,
  symbolIds: string[],
): Promise<Cluster[]> {
  if (symbolIds.length === 0) return [];

  const rows = await graphAdapter.runCypher<CypherClusterRow>(
    `MATCH (c:Cluster)
     WHERE any(sid IN c.symbols WHERE sid IN $symbolIds)
     RETURN c.id AS id, c.name AS name, c.symbols AS symbols,
            c.confidence AS confidence, c.category AS category`,
    { symbolIds },
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    symbols: r.symbols,
    confidence: parseFloat(r.confidence),
    category: r.category,
  })) as Cluster[];
}

/**
 * Fetch processes containing the given symbol IDs.
 * Requirements: 11.3, 11.4
 */
async function fetchProcessesForSymbols(
  graphAdapter: GraphAdapter,
  symbolIds: string[],
): Promise<Process[]> {
  if (symbolIds.length === 0) return [];

  const rows = await graphAdapter.runCypher<CypherProcessRow>(
    `MATCH (p:Process)
     WHERE any(step IN p.steps WHERE step.symbolId IN $symbolIds)
     RETURN p.id AS id, p.name AS name, p.entryPoint AS entryPoint,
            p.steps AS steps, p.dataFlow AS dataFlow`,
    { symbolIds },
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    entryPoint: r.entryPoint,
    steps: r.steps,
    dataFlow: r.dataFlow,
  })) as Process[];
}

/**
 * Fetch full symbol details for the given symbol IDs.
 * Requirements: 11.1
 */
async function fetchSymbols(
  graphAdapter: GraphAdapter,
  symbolIds: string[],
): Promise<Symbol[]> {
  if (symbolIds.length === 0) return [];

  const rows = await graphAdapter.runCypher<CypherSymbolRow>(
    `MATCH (s:Symbol)
     WHERE s.id IN $symbolIds
     RETURN s.id AS id, s.name AS name, s.kind AS kind,
            s.filePath AS filePath, s.startLine AS startLine,
            s.startColumn AS startColumn, s.endLine AS endLine,
            s.endColumn AS endColumn, s.signature AS signature,
            s.documentation AS documentation, s.visibility AS visibility,
            s.modifiers AS modifiers`,
    { symbolIds },
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    location: {
      filePath: r.filePath,
      startLine: parseInt(r.startLine),
      startColumn: parseInt(r.startColumn),
      endLine: parseInt(r.endLine),
      endColumn: parseInt(r.endColumn),
    },
    signature: r.signature,
    documentation: r.documentation,
    visibility: r.visibility,
    modifiers: r.modifiers,
  })) as Symbol[];
}

/**
 * Execute smart search query using VectorAdapter and EmbeddingAdapter.
 * Returns empty results when embeddings are disabled (Req 7.4).
 *
 * Steps:
 * 1. Preprocess query for consistency (Req 22.3)
 * 2. Perform semantic search to find relevant symbols (Req 11.1)
 * 3. Group symbols by cluster (Req 11.2)
 * 4. Retrieve associated processes (Req 11.3)
 * 5. Order process steps sequentially (Req 11.4)
 * 6. Return clusters with symbols and execution flows (Req 11.5)
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 22.3, 7.3, 7.4
 */
export async function executeSmartSearch(
  query: string,
  maxResults: number,
  vectorAdapter: VectorAdapter,
  graphAdapter: GraphAdapter,
  embeddingAdapter: EmbeddingAdapter,
): Promise<{
  symbols: Symbol[];
  clusters: Cluster[];
  processes: Process[];
  searchResults: SearchResult[];
}> {
  // Req 7.4 — return empty results when embeddings are disabled (no throw)
  if (!embeddingAdapter.isEnabled()) {
    return { symbols: [], clusters: [], processes: [], searchResults: [] };
  }

  // Step 1: Preprocess query for consistency (Req 22.3)
  const preprocessedQuery = preprocessQuery(query);

  // Step 2: Generate embedding and perform semantic search (Req 7.3, 11.1)
  const embedding = await embeddingAdapter.embedText(preprocessedQuery);
  if (!embedding) {
    return { symbols: [], clusters: [], processes: [], searchResults: [] };
  }

  const searchResults: SearchResult[] = await vectorAdapter.semanticSearch(
    embedding,
    maxResults * 2, // Get more candidates for clustering
  );

  const symbolIds = searchResults.map((r) => r.symbolId);

  // Fetch full symbol details
  const symbols = await fetchSymbols(graphAdapter, symbolIds);

  // Step 3: Group by cluster (Req 11.2)
  const clusters = await fetchClustersForSymbols(graphAdapter, symbolIds);

  // Step 4: Retrieve associated processes (Req 11.3)
  const processes = await fetchProcessesForSymbols(graphAdapter, symbolIds);

  // Step 5: Order process steps sequentially (Req 11.4)
  const orderedProcesses = processes.map((p) => ({
    ...p,
    steps: [...p.steps].sort((a, b) => a.order - b.order),
  }));

  // Step 6: Return results (Req 11.5)
  return {
    symbols: symbols.slice(0, maxResults),
    clusters,
    processes: orderedProcesses,
    searchResults,
  };
}
