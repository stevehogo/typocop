/**
 * smart_search MCP tool — natural language symbol search via pgvector + Neo4j.
 * Requirements: 1.1–1.8, 2.1–2.3
 */
import type { Pool } from "pg";
import type { Driver } from "neo4j-driver";
import type { MCPToolResponse, SearchResult } from "../types/index.js";
import type { GraphNode } from "../graph/connection.js";
import { generateEmbedding } from "../vector/embed.js";
import { semanticSearch } from "../vector/search.js";
import { txFindNode, txFindDependents, txFindClustersBySymbol } from "../graph/query.js";
import { SessionManager } from "./session-manager.js";
import { configurationManager } from "../config/index.js";
import { sanitizeQuery as sanitizeQueryImpl } from "../security/sanitize.js";

// Re-export for testing
export { sanitizeQueryImpl as sanitizeQuery };

const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS_CAP = 50;

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
): string {
  if (resolved.length === 0) {
    return `No symbols found for query "${query}". Try different keywords.`;
  }
  const names = resolved
    .slice(0, 3)
    .map((n) => n.properties["name"] ?? n.id)
    .join(", ");
  const clusterNote = clusters.length > 0 ? ` across ${clusters.length} cluster(s)` : "";
  return `Found ${resolved.length} symbol(s) matching "${query}"${clusterNote}: ${names}.`;
}

/**
 * Execute the smart_search MCP tool.
 * Requirements: 1.1–1.8
 */
export async function executeSmartSearchTool(
  params: Record<string, unknown>,
  vectorPool: Pool,
  driver: Driver,
  sessionManager: SessionManager,
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
  console.error(`[executeSmartSearchTool] Raw query: "${rawQuery}", Sanitized: "${sanitized}"`);
  
  const embedding = await generateEmbedding(sanitized);
  console.error(`[executeSmartSearchTool] Generated embedding with ${embedding.vector.length} dimensions`);
  
  const prefix = configurationManager.getPrefix();
  console.error(`[executeSmartSearchTool] Using prefix: "${prefix}"`);
  
  const searchResults: SearchResult[] = await semanticSearch(vectorPool, embedding, maxResults, prefix);
  console.error(`[executeSmartSearchTool] Semantic search returned ${searchResults.length} results`);

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

  const session = await sessionManager.acquire(driver);
  let resolved: GraphNode[] = [];
  let dependents: GraphNode[] = [];
  let clusters: GraphNode[] = [];

  try {
    resolved = await session.executeRead(async (tx) => {
      const nodes = await Promise.all(
        searchResults.map((r) => txFindNode(tx, r.symbolId)),
      );
      return nodes.filter((n): n is GraphNode => n !== null);
    });

    if (resolved.length > 0) {
      const topId = resolved[0]!.id;
      [dependents, clusters] = await session.executeRead(async (tx) =>
        Promise.all([
          txFindDependents(tx, topId),
          txFindClustersBySymbol(tx, topId),
        ]),
      );
    }
  } finally {
    await sessionManager.release(session);
  }

  const confidence = computeConfidence(resolved, topScore);
  const summary = buildSummary(rawQuery, resolved, clusters);

  // Create a map of symbolId to score for quick lookup
  const scoreMap = new Map(searchResults.map((r) => [r.symbolId, r.score]));

  return {
    symbols: resolved.map((n) => ({
      id: n.id,
      name: n.properties["name"] ?? n.id,
      kind: (n.properties["kind"] ?? "function") as MCPToolResponse["symbols"][number]["kind"],
      location: {
        filePath: n.properties["filePath"] ?? "",
        startLine: parseInt(n.properties["startLine"] ?? "0", 10),
      },
      relationship: "semantic-match",
      score: scoreMap.get(n.id) ?? 0,
    })),
    clusters: clusters.map((c) => ({
      id: c.id,
      name: c.properties["name"] ?? c.id,
      category: (c.properties["category"] ?? "unknown") as MCPToolResponse["clusters"][number]["category"],
      confidence,
    })),
    processes: [],
    confidence,
    riskLevel: "low",
    affectedFlows: dependents.map((d) => d.id),
    summary,
  };
}
