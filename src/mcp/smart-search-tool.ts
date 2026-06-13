/**
 * smart_search MCP tool — semantic symbol search via DatabaseAdapter.
 * Requirements: 1.1–1.8, 2.1–2.3, 7.1, 7.3, 7.4
 */
import type { DatabaseAdapter, GraphAdapter, GraphNode } from "../core/ports/persistence.js";
import { prop } from "../core/ports/persistence.js";
import type { MCPToolResponse } from "../core/domain.js";
import { sanitizeQuery as sanitizeQueryImpl } from "../security/sanitize.js";

// Re-export for testing
export { sanitizeQueryImpl as sanitizeQuery };

const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS_CAP = 200;

/**
 * Compute confidence from resolved symbols and top cosine score.
 * Requirements: 2.1, 2.2, 2.3
 */
export function computeConfidence(resolved: GraphNode[], topScore: number): number {
  if (resolved.length === 0) return 0.5;
  const resolutionRate = resolved.filter((n) => n.id !== "").length / resolved.length;
  const raw = topScore * 0.6 + resolutionRate * 0.4;
  return Math.min(0.99, Math.max(0.5, raw));
}

/**
 * Build a human-readable summary — always returns a non-empty string.
 * Requirements: 1.2
 */
export function buildSummary(
  query: string,
  resolved: GraphNode[],
  clusters: GraphNode[],
  warning?: string,
): string {
  if (warning) {
    return warning;
  }
  if (resolved.length === 0) {
    return `No symbols found for query "${query}". Try different keywords.`;
  }
  const names = resolved
    .slice(0, 3)
    .map((n) => (n.properties["name"] as string) ?? n.id)
    .join(", ");
  const clusterNote = clusters.length > 0 ? ` across ${clusters.length} cluster(s)` : "";
  return `Found ${resolved.length} symbol(s) matching "${query}"${clusterNote}: ${names}.`;
}

// ─── Graph query helpers using GraphAdapter ───────────────────────────────────

interface CypherNodeRow {
  n: { labels: string[]; properties: Record<string, string> };
}

interface CypherClusterRow {
  c: { labels: string[]; properties: Record<string, string> };
}

function rowToNode(row: CypherNodeRow): GraphNode {
  const n = row.n;
  return { id: n.properties["id"] ?? "", labels: n.labels, properties: n.properties };
}

async function findNodesByIds(graph: GraphAdapter, ids: string[]): Promise<GraphNode[]> {
  if (ids.length === 0) return [];
  const rows = await graph.runCypher<CypherNodeRow>(
    `MATCH (n:Symbol) WHERE n.id IN $ids RETURN n`,
    { ids },
  );
  return rows.map(rowToNode);
}

async function findDependentsByGraph(graph: GraphAdapter, symbolId: string): Promise<GraphNode[]> {
  const rows = await graph.runCypher<CypherNodeRow>(
    `MATCH (n:Symbol)-[e:CALLS*1..5]->(t:Symbol) WHERE t.id = $val OR t.name = $val RETURN DISTINCT n`,
    { val: symbolId },
  );
  return rows.map(rowToNode);
}

async function findClustersByGraph(graph: GraphAdapter, symbolId: string): Promise<GraphNode[]> {
  const rows = await graph.runCypher<CypherClusterRow>(
    `MATCH (c:Cluster)-[:CONTAINS]->(s:Symbol) WHERE s.id = $val OR s.name = $val RETURN DISTINCT c`,
    { val: symbolId },
  );
  return rows.map((r) => ({
    id: r.c.properties["id"] ?? "",
    labels: r.c.labels,
    properties: r.c.properties,
  }));
}

/**
 * Execute the smart_search MCP tool using DatabaseAdapter.
 * Uses VectorAdapter for semantic search and GraphAdapter for graph resolution.
 * Returns empty results when embeddings are disabled (Req 7.4).
 * Requirements: 1.1–1.8, 7.1, 7.3, 7.4
 */
export async function executeSmartSearchTool(
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
): Promise<MCPToolResponse> {
  const rawQuery = params["query"];
  if (typeof rawQuery !== "string" || rawQuery.trim() === "") {
    throw new Error("query is required");
  }

  const maxResults = Math.min(
    typeof params["maxResults"] === "number" ? params["maxResults"] : DEFAULT_MAX_RESULTS,
    MAX_RESULTS_CAP,
  );

  const sanitized = sanitizeQueryImpl(rawQuery);
  const embeddingAdapter = adapter.getEmbeddingAdapter();

  // Req 7.4 — return empty results when embeddings are disabled
  if (!embeddingAdapter.isEnabled()) {
    return {
      symbols: [],
      clusters: [],
      processes: [],
      confidence: 0.5,
      riskLevel: "low",
      affectedFlows: [],
      summary: buildSummary(
        rawQuery,
        [],
        [],
        "⚠️ Embeddings are disabled (EMBEDDING_PROVIDER=none). Semantic search is unavailable. Enable embeddings to use this feature.",
      ),
    };
  }

  const embedding = await embeddingAdapter.embedText(sanitized);
  if (!embedding) {
    return {
      symbols: [],
      clusters: [],
      processes: [],
      confidence: 0.5,
      riskLevel: "low",
      affectedFlows: [],
      summary: buildSummary(rawQuery, [], []),
    };
  }

  const vectorAdapter = adapter.getVectorAdapter();
  const searchResults = await vectorAdapter.semanticSearch(embedding, maxResults);

  if (searchResults.length === 0) {
    return {
      symbols: [],
      clusters: [],
      processes: [],
      confidence: 0.5,
      riskLevel: "low",
      affectedFlows: [],
      summary: buildSummary(rawQuery, [], []),
    };
  }

  const topScore = searchResults[0]?.score ?? 0;
  const graphAdapter = adapter.getGraphAdapter();
  const symbolIds = searchResults.map((r) => r.symbolId);

  // Separate direct symbol IDs from cluster-prefixed IDs
  const directIds: string[] = [];
  const clusterIds: string[] = [];
  for (const result of searchResults) {
    if (result.symbolId.startsWith("cluster:")) {
      clusterIds.push(result.symbolId);
      // Resolve cluster to its member symbol via metadata
      const memberSymbolId = result.metadata["symbolId"];
      if (memberSymbolId) {
        directIds.push(memberSymbolId);
      }
    } else {
      directIds.push(result.symbolId);
    }
  }

  const resolved = await findNodesByIds(graphAdapter, directIds);
  let dependents: GraphNode[] = [];
  let clusters: GraphNode[] = [];

  if (resolved.length > 0) {
    const topId = resolved[0]!.id;
    [dependents, clusters] = await Promise.all([
      findDependentsByGraph(graphAdapter, topId),
      findClustersByGraph(graphAdapter, topId),
    ]);
  }

  const confidence = computeConfidence(resolved, topScore);
  const summary = buildSummary(rawQuery, resolved, clusters);

  // Build score map: map both direct symbolIds and cluster-resolved symbolIds
  const scoreMap = new Map<string, number>();
  for (const r of searchResults) {
    if (r.symbolId.startsWith("cluster:")) {
      const memberSymbolId = r.metadata["symbolId"];
      if (memberSymbolId) {
        scoreMap.set(memberSymbolId, r.score);
      }
    } else {
      scoreMap.set(r.symbolId, r.score);
    }
  }

  return {
    symbols: resolved.map((n) => ({
      id: n.id,
      name: prop(n, "name", n.id),
      kind: prop(n, "kind", "function") as MCPToolResponse["symbols"][number]["kind"],
      location: {
        filePath: prop(n, "filePath"),
        startLine: parseInt(prop(n, "startLine", "0"), 10),
      },
      relationship: "semantic-match",
      score: scoreMap.get(n.id) ?? 0,
    })),
    clusters: clusters.map((c) => ({
      id: c.id,
      name: prop(c, "name", c.id),
      category: prop(c, "category", "unknown") as MCPToolResponse["clusters"][number]["category"],
      confidence,
    })),
    processes: [],
    confidence,
    riskLevel: "low",
    affectedFlows: dependents.map((d) => d.id),
    summary,
  };
}
