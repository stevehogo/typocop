/**
 * Smart search query implementation.
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 22.3
 */
import type { Pool } from "pg";
import type { Session } from "neo4j-driver";
import type { Symbol, Cluster, Process, SearchResult, Embedding } from "../types/index.js";
import { semanticSearch } from "../vector/search.js";
import { preprocessQuery } from "./preprocess.js";

/**
 * Embedding generator function type for dependency injection.
 */
export type EmbedFunction = (query: string) => Promise<Embedding>;

/**
 * Fetch clusters containing the given symbol IDs.
 * Requirements: 11.2
 */
async function fetchClustersForSymbols(
  session: Session,
  symbolIds: string[],
): Promise<Cluster[]> {
  if (symbolIds.length === 0) return [];

  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (c:Cluster)
       WHERE any(sid IN c.symbols WHERE sid IN $symbolIds)
       RETURN c.id AS id, c.name AS name, c.symbols AS symbols,
              c.confidence AS confidence, c.category AS category`,
      { symbolIds },
    ),
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    name: r.get("name") as string,
    symbols: r.get("symbols") as string[],
    confidence: parseFloat(r.get("confidence") as string),
    category: r.get("category") as string,
  })) as Cluster[];
}

/**
 * Fetch processes containing the given symbol IDs.
 * Requirements: 11.3, 11.4
 */
async function fetchProcessesForSymbols(
  session: Session,
  symbolIds: string[],
): Promise<Process[]> {
  if (symbolIds.length === 0) return [];

  const result = await session.run(
    `MATCH (p:Process)
     WHERE any(step IN p.steps WHERE step.symbolId IN $symbolIds)
     RETURN p.id AS id, p.name AS name, p.entryPoint AS entryPoint,
            p.steps AS steps, p.dataFlow AS dataFlow`,
    { symbolIds },
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    name: r.get("name") as string,
    entryPoint: r.get("entryPoint") as string,
    steps: r.get("steps") as Array<{ order: number; symbolId: string; description: string }>,
    dataFlow: r.get("dataFlow") as Array<{ from: string; to: string; dataType?: string }>,
  })) as Process[];
}

/**
 * Fetch full symbol details for the given symbol IDs.
 * Requirements: 11.1
 */
async function fetchSymbols(
  session: Session,
  symbolIds: string[],
): Promise<Symbol[]> {
  if (symbolIds.length === 0) return [];

  const result = await session.run(
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

  return result.records.map((r) => ({
    id: r.get("id") as string,
    name: r.get("name") as string,
    kind: r.get("kind") as string,
    location: {
      filePath: r.get("filePath") as string,
      startLine: parseInt(r.get("startLine") as string),
      startColumn: parseInt(r.get("startColumn") as string),
      endLine: parseInt(r.get("endLine") as string),
      endColumn: parseInt(r.get("endColumn") as string),
    },
    signature: r.get("signature") as string | undefined,
    documentation: r.get("documentation") as string | undefined,
    visibility: r.get("visibility") as string,
    modifiers: r.get("modifiers") as string[],
  })) as Symbol[];
}

/**
 * Execute smart search query.
 * 
 * Steps:
 * 1. Preprocess query for consistency (Req 22.3)
 * 2. Perform semantic search to find relevant symbols (Req 11.1)
 * 3. Group symbols by cluster (Req 11.2)
 * 4. Retrieve associated processes (Req 11.3)
 * 5. Order process steps sequentially (Req 11.4)
 * 6. Return clusters with symbols and execution flows (Req 11.5)
 * 
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 22.3
 */
export async function executeSmartSearch(
  query: string,
  maxResults: number,
  vectorPool: Pool,
  graphSession: Session,
  embedFn: EmbedFunction,
  prefix: string,
): Promise<{
  symbols: Symbol[];
  clusters: Cluster[];
  processes: Process[];
  searchResults: SearchResult[];
}> {
  // Step 1: Preprocess query for consistency (Req 22.3)
  const preprocessedQuery = preprocessQuery(query);

  // Step 2: Semantic search (Req 11.1)
  const embedding = await embedFn(preprocessedQuery);
  const searchResults: SearchResult[] = await semanticSearch(
    vectorPool,
    embedding,
    maxResults * 2, // Get more candidates for clustering
    prefix,
  );

  const symbolIds = searchResults.map((r) => r.symbolId);

  // Fetch full symbol details
  const symbols = await fetchSymbols(graphSession, symbolIds);

  // Step 3: Group by cluster (Req 11.2)
  const clusters = await fetchClustersForSymbols(graphSession, symbolIds);

  // Step 4: Retrieve associated processes (Req 11.3)
  const processes = await fetchProcessesForSymbols(graphSession, symbolIds);

  // Step 5: Order process steps sequentially (Req 11.4)
  // Steps are already ordered by the `order` field in the database
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
