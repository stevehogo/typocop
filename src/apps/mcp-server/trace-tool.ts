/**
 * `trace` MCP tool — shortest CALLS|CONTAINS hop chain between two symbols (D3).
 *
 * Resolves both endpoints (exact → fuzzy), runs a bounded BFS shortest-path
 * search via {@link executeTracePath}, and renders the hop chain plus a
 * human-readable `summary`. The hop chain is attached on the ADDITIVE optional
 * `trace` field of {@link MCPToolResponse}; the affected-flows array doubles as
 * a flat ordered list of the hop symbol ids for non-trace-aware consumers.
 * Requirements: 15.1, 15.5, 15.6, 15.8, 16.7
 */
import type { DatabaseAdapter } from "../../core/ports/persistence.js";
import type { MCPToolResponse } from "../../core/domain.js";
import { executeTracePath, type TracePathResult } from "../../application/querying/trace-path.js";
import type { SymbolResolution } from "../../application/querying/symbol-resolver.js";

/** Describe how an endpoint resolved, for the summary line. */
function describeEndpoint(label: string, name: string, res: SymbolResolution): string {
  if (res.kind === "not_found") {
    const sugg = res.suggestions.length > 0
      ? ` Did you mean: ${res.suggestions.join(", ")}?`
      : " No similar symbols found.";
    return `${label} '${name}' not found.${sugg}`;
  }
  if (res.kind === "fuzzy") {
    return `${label} '${name}' → fuzzy matched '${res.matchedName}'.`;
  }
  return "";
}

/** Build the human-readable summary from the trace result. */
export function buildTraceSummary(from: string, to: string, result: TracePathResult): string {
  const { from: fromRes, to: toRes } = result.resolution;

  if (fromRes.kind === "not_found" || toRes.kind === "not_found") {
    const parts: string[] = [];
    if (fromRes.kind === "not_found") parts.push(describeEndpoint("Source", from, fromRes));
    if (toRes.kind === "not_found") parts.push(describeEndpoint("Destination", to, toRes));
    return `No path traced: ${parts.join(" ")}`;
  }

  const fuzzyNotes = [describeEndpoint("Source", from, fromRes), describeEndpoint("Destination", to, toRes)]
    .filter(Boolean)
    .join(" ");
  const prefix = fuzzyNotes ? `${fuzzyNotes} ` : "";

  if (!result.found) {
    return `${prefix}No CALLS/CONTAINS path found from '${from}' to '${to}' within the search depth. ` +
      `They may be unconnected, connected only via other edge types, or further apart than the maxDepth allows.`;
  }

  const chain = result.hops
    .map((h, i) => (i < result.hops.length - 1 ? `${h.name} -[${h.edgeToNext}]->` : h.name))
    .join(" ");
  return `${prefix}Path found from '${from}' to '${to}' in ${result.length} hop${result.length === 1 ? "" : "s"}: ${chain}.`;
}

/**
 * Execute the `trace` MCP tool.
 * Requirements: 15.1, 15.5, 15.6, 15.8, 16.7
 */
export async function executeTraceTool(
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
): Promise<MCPToolResponse> {
  const fromSymbol = params.fromSymbol as string;
  const toSymbol = params.toSymbol as string;
  const maxDepth = typeof params.maxDepth === "number" ? params.maxDepth : undefined;

  const graph = adapter.getGraphAdapter();
  const result = await executeTracePath(fromSymbol, toSymbol, maxDepth, graph);

  const summary = buildTraceSummary(fromSymbol, toSymbol, result);

  return {
    symbols: result.hops.map((h) => ({
      id: h.symbolId,
      name: h.name,
      // The hop nodes are :Symbol nodes; their kind isn't projected by the path
      // search, so default to "function" (the response symbol shape requires a
      // kind). Consumers that need exact kinds should call get_symbol_context.
      kind: "function" as MCPToolResponse["symbols"][number]["kind"],
      location: { filePath: h.filePath, startLine: h.startLine },
      relationship: "trace-hop",
    })),
    clusters: [],
    processes: [],
    confidence: result.found ? 0.92 : 0.5,
    riskLevel: "low",
    // Flat ordered hop ids for consumers that don't read the `trace` field.
    affectedFlows: result.hops.map((h) => h.symbolId),
    summary,
    trace: {
      found: result.found,
      length: result.length,
      hops: result.hops.map((h) => ({
        symbolId: h.symbolId,
        name: h.name,
        filePath: h.filePath,
        startLine: h.startLine,
        ...(h.edgeToNext ? { edgeToNext: h.edgeToNext } : {}),
      })),
    },
  };
}
