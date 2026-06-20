/**
 * `shape_check` + `api_impact` MCP tools (E3).
 *
 * `shape_check` queries the graph for route symbols (carrying `responseKeys`)
 * and consumer symbols (carrying `accessedKeys`), pairs them via the pure
 * {@link shapeCheck} engine, and reports keys a consumer reads that no route
 * returns. `api_impact` composes route discovery + shape_check + impact_analysis
 * for a single route into one response.
 */
import type { DatabaseAdapter, GraphAdapter } from "../../core/ports/persistence.js";
import { prop } from "../../core/ports/persistence.js";
import type { MCPToolResponse } from "../../core/domain.js";
import { rowToNode } from "../../application/querying/graph-helpers.js";
import type { CypherNodeRow } from "../../application/querying/graph-helpers.js";
import { executeImpactAnalysis } from "../../application/querying/impact-analysis.js";
import {
  shapeCheck,
  type RouteShape,
  type ConsumerShape,
} from "../../application/querying/shape-check.js";

/** Parse a persisted JSON-string-array prop back to `string[]` (safe). */
function parseKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Load route shapes: Symbols whose `responseKeys` prop is a non-empty array. */
async function loadRoutes(graph: GraphAdapter): Promise<RouteShape[]> {
  const rows = await graph.runCypher<CypherNodeRow>(
    `MATCH (s:Symbol)
     WHERE s.responseKeys IS NOT NULL AND s.responseKeys <> '[]'
     RETURN s AS n
     ORDER BY s.id ASC`,
    {},
  ) ?? [];
  const routes: RouteShape[] = [];
  for (const row of rows) {
    if (!row?.n?.properties) continue;
    const node = rowToNode(row);
    const responseKeys = parseKeys(prop(node, "responseKeys", "[]"));
    if (responseKeys.length === 0) continue;
    routes.push({
      symbolId: node.id,
      name: prop(node, "name", node.id),
      filePath: prop(node, "filePath"),
      responseKeys,
    });
  }
  return routes;
}

/** Load consumer shapes: Symbols whose `accessedKeys` prop is a non-empty array. */
async function loadConsumers(graph: GraphAdapter): Promise<ConsumerShape[]> {
  const rows = await graph.runCypher<CypherNodeRow>(
    `MATCH (s:Symbol)
     WHERE s.accessedKeys IS NOT NULL AND s.accessedKeys <> '[]'
     RETURN s AS n
     ORDER BY s.id ASC`,
    {},
  ) ?? [];
  // Count how many routes each FILE fetches, to downgrade confidence (R9). A
  // consumer "fetches a route" when its file contains >1 route symbol; here we
  // approximate per-file route fan-out from the consumer's own file.
  const consumers: ConsumerShape[] = [];
  for (const row of rows) {
    if (!row?.n?.properties) continue;
    const node = rowToNode(row);
    const accessedKeys = parseKeys(prop(node, "accessedKeys", "[]"));
    if (accessedKeys.length === 0) continue;
    consumers.push({
      symbolId: node.id,
      name: prop(node, "name", node.id),
      filePath: prop(node, "filePath"),
      accessedKeys,
    });
  }
  return consumers;
}

/**
 * Count routes per consumer FILE so a consumer that fetches multiple routes is
 * downgraded to `low` confidence. We approximate "fetches" by routes declared in
 * the same file as the consumer (the common single-file route+handler layout);
 * cross-file fetch tracking is a fast-follow.
 */
function withFileFanOut(
  consumers: readonly ConsumerShape[],
  routes: readonly RouteShape[],
): ConsumerShape[] {
  const routesPerFile = new Map<string, number>();
  for (const r of routes) {
    routesPerFile.set(r.filePath, (routesPerFile.get(r.filePath) ?? 0) + 1);
  }
  const totalRoutes = routes.length;
  return consumers.map((c) => {
    // If the consumer shares a file with multiple routes, fan-out is that count;
    // otherwise, when the whole graph exposes multiple routes, the union model
    // makes any single-route attribution ambiguous → treat as multi-route.
    const inFile = routesPerFile.get(c.filePath) ?? 0;
    const routesFetchedInFile = inFile > 0 ? inFile : totalRoutes;
    return { ...c, routesFetchedInFile };
  });
}

/** Build the standard empty-shaped MCPToolResponse scaffold. */
function emptyResponse(summary: string): MCPToolResponse {
  return {
    symbols: [],
    clusters: [],
    processes: [],
    confidence: 1.0,
    riskLevel: "low",
    affectedFlows: [],
    summary,
  };
}

/**
 * Execute `shape_check`: report consumer key reads that no route returns.
 */
export async function executeShapeCheck(
  _params: Record<string, unknown>,
  adapter: DatabaseAdapter,
): Promise<MCPToolResponse> {
  const graph = adapter.getGraphAdapter();
  const routes = await loadRoutes(graph);
  const consumers = withFileFanOut(await loadConsumers(graph), routes);

  const result = shapeCheck(routes, consumers);

  const high = result.mismatches.filter((m) => m.confidence === "high").length;
  const low = result.mismatches.length - high;
  const summary = result.mismatches.length === 0
    ? `No API contract drift: ${consumers.length} consumer(s) read only keys returned by ${routes.length} route(s).`
    : `Found ${result.mismatches.length} contract mismatch(es) across ${routes.length} route(s) and ` +
      `${consumers.length} consumer(s): ${high} high-confidence, ${low} low-confidence. ` +
      `e.g. '${result.mismatches[0]!.consumerName}' reads '${result.mismatches[0]!.key}' ` +
      `but no route returns it.`;

  const response = emptyResponse(summary);
  response.symbols = result.mismatches.map((m) => ({
    id: m.consumerId,
    name: m.consumerName,
    kind: "function" as const,
    location: { filePath: m.filePath, startLine: 0 },
    relationship: "shape-mismatch",
    accessedKeys: [m.key],
    responseKeys: m.availableKeys,
  }));
  response.riskLevel = high > 0 ? "medium" : "low";
  response.shapeCheck = {
    pairsChecked: result.pairsChecked,
    mismatches: result.mismatches.map((m) => ({
      consumerId: m.consumerId,
      consumerName: m.consumerName,
      filePath: m.filePath,
      key: m.key,
      availableKeys: m.availableKeys,
      confidence: m.confidence,
    })),
  };
  return response;
}

/**
 * Execute `api_impact` = route_map + shape_check + impact for a single route.
 *
 * Resolves the named route (by symbol name), runs `shape_check` across the
 * graph, and overlays an impact analysis of the route symbol so an agent sees,
 * in one call: who returns what, which consumers read missing keys, and the
 * blast radius of touching the route.
 */
export async function executeApiImpact(
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
): Promise<MCPToolResponse> {
  const route = params.route as string;
  const graph = adapter.getGraphAdapter();

  // 1) shape_check across the whole graph (the drift surface).
  const shape = await executeShapeCheck(params, adapter);

  // 2) impact analysis of the named route symbol (blast radius).
  const impact = await executeImpactAnalysis(route, 100, graph);

  const driftForRoute = (shape.shapeCheck?.mismatches ?? []).length;
  const summary =
    `API impact for route '${route}': ${impact.symbols.length} affected symbol(s), ` +
    `risk ${impact.riskLevel.toUpperCase()}; ${driftForRoute} contract mismatch(es) across consumers.`;

  return {
    symbols: impact.symbols.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      location: { filePath: s.location.filePath, startLine: s.location.startLine },
      relationship: "api-impact",
    })),
    clusters: [],
    processes: [],
    confidence: impact.confidence,
    riskLevel: impact.riskLevel,
    affectedFlows: impact.affectedFlows,
    summary,
    shapeCheck: shape.shapeCheck,
  };
}
