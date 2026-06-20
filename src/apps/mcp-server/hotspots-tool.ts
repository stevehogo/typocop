/**
 * `find_hotspots` MCP tool (E2).
 *
 * Lists the most cyclomatically-complex symbols above a threshold, ordered
 * DESC and paged. Each result carries its three complexity metrics. Strictly
 * read-only.
 */
import type { DatabaseAdapter } from "../../core/ports/persistence.js";
import type { MCPToolResponse } from "../../core/domain.js";
import { findHotspots } from "../../application/querying/hotspots.js";

/**
 * Execute the `find_hotspots` MCP tool.
 */
export async function executeFindHotspots(
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
): Promise<MCPToolResponse> {
  const minComplexity = typeof params.minComplexity === "number" ? params.minComplexity : undefined;
  const maxResults = typeof params.maxResults === "number" ? params.maxResults : undefined;
  const offset = typeof params.offset === "number" ? params.offset : undefined;

  const graph = adapter.getGraphAdapter();
  const result = await findHotspots(graph, {
    ...(minComplexity !== undefined ? { minComplexity } : {}),
    ...(maxResults !== undefined ? { maxResults } : {}),
    ...(offset !== undefined ? { offset } : {}),
  });

  const shown = result.hotspots.length;
  const threshold = minComplexity !== undefined ? minComplexity : 10;
  const summary = shown === 0
    ? `No complexity hotspots found above cyclomatic complexity ${threshold}.`
    : `Found ${shown} complexity hotspot${shown === 1 ? "" : "s"} (cyclomatic > ${threshold}), ` +
      `most complex first. Highest: ${result.hotspots[0]!.symbol.name} ` +
      `(cyclomatic ${result.hotspots[0]!.cyclomatic}).`;

  return {
    symbols: result.hotspots.map(({ symbol, cyclomatic, cognitive, maxLoopDepth }) => ({
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      location: { filePath: symbol.location.filePath, startLine: symbol.location.startLine },
      relationship: "complexity-hotspot",
      cyclomatic,
      cognitive,
      maxLoopDepth,
    })),
    clusters: [],
    processes: [],
    confidence: 1.0,
    riskLevel: "low",
    affectedFlows: [],
    summary,
  };
}
