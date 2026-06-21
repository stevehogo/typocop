/**
 * Data flow tracing query logic.
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 7.2, 1.1, 1.2, 1.4, 1.5, 4.2, 4.3, 4.4, 4.5
 */
import type { GraphAdapter, GraphNode } from "../../core/ports/persistence.js";
import type { Symbol, Relationship, QueryResult } from "../../core/domain.js";
import { MAX_TRAVERSAL_DEPTH } from "../../platform/utils/limits.js";
import { graphNodeToSymbol, rowToTouchedNode } from "./graph-helpers.js";
import type { DataFlowTraceRow, TouchedNode } from "./graph-helpers.js";
import { resolveSymbol, type SymbolResolution } from "./symbol-resolver.js";
import { classifyLayer } from "./framework-layers.js";

// ─── Graph query helpers using GraphAdapter ───────────────────────────────────

/**
 * Wave 5: find the CALLS-reachable dependencies of an entry point AND, per
 * reachable node, the EDGE-RESOLVED data-touch evidence — whether it is a route
 * handler (`HANDLES_ROUTE` → APIEndpoint) or a data-access symbol
 * (`READS_FROM_DB`/`WRITES_TO_DB` → DBModel), plus the touch edge's `confidence`.
 *
 * The data-touch edges point Symbol → (synthetic) endpoint/model, so from the
 * handler / data-access symbol's perspective they are OUTBOUND. The `OPTIONAL
 * MATCH` arms return null for graphs indexed before the data-touch pass ran —
 * `touchLayer`/`edgeConfidence` stay undefined and the caller falls back to the
 * `classifyLayer` regex (graceful degradation).
 */
async function findDependencies(graph: GraphAdapter, symbolId: string): Promise<TouchedNode[]> {
  const rows = await graph.runCypher<DataFlowTraceRow>(
    `MATCH (s:Symbol)-[e:CALLS*1..${MAX_TRAVERSAL_DEPTH}]->(n:Symbol) WHERE s.id = $val OR s.name = $val ` +
      `OPTIONAL MATCH (n)-[hr:HANDLES_ROUTE]->(:Symbol) ` +
      `OPTIONAL MATCH (n)-[rw:READS_FROM_DB|WRITES_TO_DB]->(:Symbol) ` +
      `RETURN DISTINCT n, hr IS NOT NULL AS hasRoute, rw IS NOT NULL AS hasDb, ` +
      `coalesce(hr.confidence, rw.confidence) AS edgeConfidence`,
    { val: symbolId },
  );
  return rows.map(rowToTouchedNode);
}

/** Mean of a non-empty number list. */
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
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

  // Req 13.2-13.5 — trace through all dependencies (edge-resolved touch evidence)
  const dependencyNodes = await findDependencies(graphAdapter, entryPoint);

  // Classify nodes by layer. Wave 5: prefer the EDGE-RESOLVED layer (a real
  // HANDLES_ROUTE → `api`, a real READS/WRITES_TO_DB → `model`) over the
  // `classifyLayer` name/path/signature regex, which is now the documented
  // FALLBACK for nodes with no data-touch edge (graceful degradation on graphs
  // indexed before the data-touch pass ran). `controller`/`service`/`repository`
  // have no dedicated edge type, so they still come from the regex.
  const layeredNodes = new Map<string, GraphNode[]>();
  layeredNodes.set("api", [entryNode]);

  for (const dep of dependencyNodes) {
    const layer = dep.touchLayer ?? classifyLayer(dep.node, framework);
    if (!layeredNodes.has(layer)) {
      layeredNodes.set(layer, []);
    }
    layeredNodes.get(layer)!.push(dep.node);
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

  // Wave 5: when the trace is backed by REAL data-touch edges, derive confidence
  // from those edges' `metadata.confidence` (a ground-truth signal, stronger than
  // the name-regex guess) and elevate it above the regex ladder. The hardcoded
  // ladder is kept STRICTLY as the fallback for the no-edge / pre-data-touch case
  // (same graceful-degradation principle as the layer classification above).
  const edgeConfidences = dependencyNodes
    .map((d) => d.edgeConfidence)
    .filter((c): c is number => typeof c === "number");
  const ladderConfidence = isFullTrace ? 0.92 : pathSymbols.length > 1 ? 0.75 : 0.6;
  const confidence = edgeConfidences.length > 0
    // Floor at the ladder value so an edge-resolved trace is never scored LOWER
    // than the regex path, and lift toward 1.0 with the edges' own confidence.
    ? Math.max(0, Math.min(1, Math.max(ladderConfidence, mean(edgeConfidences) + 0.05)))
    : ladderConfidence;

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
