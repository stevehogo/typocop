/**
 * `shape_check` MCP tool (E3) — one tool, two modes via an optional `route`.
 *
 * With NO `route`: queries the graph for route symbols (carrying `responseKeys`)
 * and consumer symbols (carrying `accessedKeys`), pairs them via the pure
 * {@link shapeCheck} engine, and reports keys a consumer reads that no route
 * returns (graph-wide contract drift).
 *
 * With a `route`: scopes to that route — overlays the graph-wide drift surface
 * with an `impact_analysis` of the route symbol (its blast radius). This is the
 * former standalone `api_impact` tool, folded in as the route mode.
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
 * Graph-wide contract drift: report consumer key reads that no route returns.
 * The no-`route` mode of {@link executeShapeCheck}; also reused by the route
 * mode (called directly, NOT via executeShapeCheck, to avoid recursion).
 */
async function runWholeGraphShapeCheck(
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
 * Execute `shape_check`. With no `route`: graph-wide contract drift. With a
 * `route`: that route's blast radius (impact analysis) overlaid with the
 * graph-wide drift surface — the former `api_impact` tool, folded in.
 *
 * The route mode calls {@link runWholeGraphShapeCheck} directly (NOT this
 * function) for the drift surface, so there is no recursion.
 */
export async function executeShapeCheck(
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
): Promise<MCPToolResponse> {
  const route = typeof params.route === "string" && params.route.trim() !== ""
    ? params.route
    : undefined;

  if (!route) {
    return runWholeGraphShapeCheck(adapter);
  }

  const graph = adapter.getGraphAdapter();
  // Drift surface (whole graph) + blast radius of the named route symbol.
  const shape = await runWholeGraphShapeCheck(adapter);
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
