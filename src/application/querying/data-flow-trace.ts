/**
 * Data flow tracing query logic.
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 7.2, 1.1, 1.2, 1.4, 1.5, 4.2, 4.3, 4.4, 4.5
 */
import type { GraphAdapter, GraphNode } from "../../core/ports/persistence.js";
import type { Symbol, Relationship, QueryResult } from "../../core/domain.js";
import { MAX_TRAVERSAL_DEPTH } from "../../platform/utils/limits.js";
import { rowToNode, graphNodeToSymbol } from "./graph-helpers.js";
import type { CypherNodeRow } from "./graph-helpers.js";
import { resolveSymbol, type SymbolResolution } from "./symbol-resolver.js";
import { classifyLayer } from "./framework-layers.js";

// ─── Graph query helpers using GraphAdapter ───────────────────────────────────

async function findDependencies(graph: GraphAdapter, symbolId: string): Promise<GraphNode[]> {
  const rows = await graph.runCypher<CypherNodeRow>(
    `MATCH (s:Symbol)-[e:CALLS*1..${MAX_TRAVERSAL_DEPTH}]->(n:Symbol) WHERE s.id = $val OR s.name = $val RETURN DISTINCT n`,
    { val: symbolId },
  );
  return rows.map(rowToNode);
}

/** Return type for executeDataFlowTrace, including resolution info for callers. */
export type DataFlowTraceResult = { resolution: SymbolResolution } & Pick<QueryResult, "symbols" | "relationships" | "clusters" | "processes" | "confidence" | "riskLevel" | "affectedFlows">;

/**
 * Execute a data flow tracing query using GraphAdapter.runCypher().
 * Traces from API endpoint through controllers, services, repositories to database models.
 * Uses resolveSymbol for exact → fuzzy fallback (Req 1.1, 1.2, 1.4, 1.5).
 * Uses classifyLayer from framework-layers for framework-aware classification (Req 4.2, 4.3, 4.4, 4.5).
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 7.2, 1.1, 1.2, 1.4, 1.5, 4.2, 4.3, 4.4, 4.5
 */
export async function executeDataFlowTrace(
  entryPoint: string,
  maxResults: number,
  graphAdapter: GraphAdapter,
  framework?: string,
): Promise<DataFlowTraceResult> {
  // Req 13.1, 1.1, 1.2, 1.4 — resolve entry point symbol (exact → fuzzy → not_found)
  const resolution = await resolveSymbol(entryPoint, graphAdapter);

  if (resolution.kind === "not_found") {
    return {
      resolution,
      symbols: [],
      relationships: [],
      clusters: [],
      processes: [],
      confidence: 0.5,
      riskLevel: "low" as const,
      affectedFlows: [],
    };
  }

  // Both "exact" and "fuzzy" provide a resolved node
  const entryNode = resolution.node;

  // Req 13.2-13.5 — trace through all dependencies
  const dependencyNodes = await findDependencies(graphAdapter, entryPoint);

  // Classify nodes by layer using framework-aware classification (Req 4.2, 4.3, 4.4, 4.5)
  const layeredNodes = new Map<string, GraphNode[]>();
  layeredNodes.set("api", [entryNode]);

  for (const node of dependencyNodes) {
    const layer = classifyLayer(node, framework);
    if (!layeredNodes.has(layer)) {
      layeredNodes.set(layer, []);
    }
    layeredNodes.get(layer)!.push(node);
  }

  // Build ordered path: API → Controller → Service → Repository → Model
  const orderedLayers = ["api", "controller", "service", "repository", "model"];
  const pathSymbols: Symbol[] = [];
  const relationships: Relationship[] = [];

  for (const layer of orderedLayers) {
    const nodes = layeredNodes.get(layer) ?? [];
    pathSymbols.push(...nodes.map(graphNodeToSymbol));
  }

  // Build relationships between consecutive symbols
  for (let i = 0; i < pathSymbols.length - 1; i++) {
    relationships.push({
      id: `${pathSymbols[i].id}->calls->${pathSymbols[i + 1].id}`,
      source: pathSymbols[i].id,
      target: pathSymbols[i + 1].id,
      relType: "calls" as const,
      metadata: {},
    });
  }

  // Req 13.6 — return complete path
  const allSymbols = pathSymbols.slice(0, maxResults);

  // Req 13.7 — check for Full tracing (API + Controller + DB)
  const hasApi = (layeredNodes.get("api") ?? []).length > 0;
  const hasController = (layeredNodes.get("controller") ?? []).length > 0;
  const hasModel = (layeredNodes.get("model") ?? []).length > 0;
  const isFullTrace = hasApi && hasController && hasModel;

  const confidence = isFullTrace ? 0.92 : pathSymbols.length > 1 ? 0.75 : 0.60;

  return {
    resolution,
    symbols: allSymbols,
    relationships,
    clusters: [],
    processes: [],
    confidence,
    riskLevel: "low" as const,
    affectedFlows: orderedLayers.filter((l) => (layeredNodes.get(l) ?? []).length > 0),
  };
}
