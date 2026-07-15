/**
 * `route_map` MCP tool (Wave 8 · T4).
 *
 * Enumerates all API routes the indexer linked a handler to, via the persisted
 * `HANDLES_ROUTE` edges (W5/W6, incl. Laravel resource expansion). Distinct from
 * `trace_data_flow` (traces FROM one endpoint) and `shape_check` (checks response
 * contract drift): this just LISTS the route surface.
 *
 * Strictly read-only. DEGRADE-TO-EMPTY: when the data-touch pass did not run at
 * index time the `HANDLES_ROUTE` table is empty, so this returns a clear empty
 * result (`routes: []`, low confidence, a "may be disabled" summary) — never an
 * error.
 */
import type { DatabaseAdapter } from "../../core/ports/persistence.js";
import type { MCPToolResponse } from "../../core/domain.js";
import { findRoutes } from "../../application/querying/route-map.js";

/**
 * Execute the `route_map` MCP tool.
 */
export async function executeRouteMap(
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
): Promise<MCPToolResponse> {
  const maxResults = typeof params.maxResults === "number" ? params.maxResults : undefined;

  const graph = adapter.getGraphAdapter();
  const result = await findRoutes(graph, {
    ...(maxResults ? { maxResults } : {}),
  });

  const shown = result.routes.length;
  const cappedNote = result.totalFound > shown ? ` (showing first ${shown} of ${result.totalFound})` : "";
  const summary = shown === 0
    ? "No routes found (data-touch indexing may be disabled, or this codebase exposes no HTTP routes)."
    : `Found ${result.totalFound} route${result.totalFound === 1 ? "" : "s"}${cappedNote}.`;

  return {
    symbols: result.routes.map((r) => ({
      id: r.endpointId,
      name: r.endpointName,
      kind: "function" as const,
      location: { filePath: r.handlerFilePath, startLine: 0 },
      relationship: "route-endpoint",
    })),
    clusters: [],
    processes: [],
    confidence: shown === 0 ? 0.3 : 0.85,
    riskLevel: "low",
    affectedFlows: [],
    summary,
    routeMap: {
      routes: result.routes.map((r) => ({
        endpointId: r.endpointId,
        endpointName: r.endpointName,
        handlerId: r.handlerId,
        handlerName: r.handlerName,
        filePath: r.handlerFilePath,
        ...(r.confidence !== undefined ? { confidence: r.confidence } : {}),
        ...(r.reason ? { reason: r.reason } : {}),
      })),
      totalFound: result.totalFound,
    },
  };
}
