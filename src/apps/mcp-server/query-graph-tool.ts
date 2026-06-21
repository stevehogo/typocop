/**
 * `query_graph` MCP tool (Wave 8 · T9).
 *
 * Exposes a GUARDED, READ-ONLY, row-capped Cypher query over the knowledge
 * graph so agents can ask questions the canned tools don't cover. This is a
 * thin adapter between MCP params and the {@link queryGraph} querying fn (which
 * owns all guardrails); the wrapper only resolves the persisted label prefix to
 * strip, coerces params, and shapes the {@link MCPToolResponse}.
 *
 * Strictly read-only — never mutates code or the graph. Write/DDL/procedure and
 * multi-statement inputs are rejected PRE-execution by the querying fn.
 * Requirements: 15.1, 15.5, 15.6, 15.8
 */
import type { DatabaseAdapter } from "../../core/ports/persistence.js";
import type { MCPToolResponse } from "../../core/domain.js";
import { configurationManager } from "../../platform/config/index.js";
import { queryGraph } from "../../application/querying/query-graph.js";

/**
 * Resolve the persisted label prefix to strip from results. Mirrors the source
 * `server.ts` uses (`configurationManager.getPrefix()`); falls back to the
 * default `tpc_` when the manager hasn't been initialized (e.g. unit tests that
 * call the tool directly) so prefix stripping still works.
 */
function resolvePrefix(): string {
  try {
    return configurationManager.getPrefix();
  } catch {
    return "tpc_";
  }
}

/**
 * Execute the `query_graph` MCP tool.
 * Requirements: 15.1, 15.5, 15.6, 15.8
 */
export async function executeQueryGraph(
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
): Promise<MCPToolResponse> {
  const cypher = typeof params.cypher === "string" ? params.cypher : "";
  const limit = typeof params.limit === "number" ? params.limit : undefined;
  const prefix = resolvePrefix();

  const graph = adapter.getGraphAdapter();
  const result = await queryGraph(graph, {
    cypher,
    ...(limit !== undefined ? { limit } : {}),
    prefix,
  });

  const summary = !result.ok
    ? `Query rejected — ${result.unsupported ?? "unsupported query"}. ` +
      `query_graph is read-only: only a single MATCH/OPTIONAL MATCH/WITH/UNWIND/RETURN query is allowed (no CREATE/MERGE/SET/DELETE/DROP/CALL).`
    : result.rowCount === 0
      ? `Query returned no rows.`
      : `Query returned ${result.rowCount} row${result.rowCount === 1 ? "" : "s"}` +
        (result.truncated ? ` (truncated to the row cap of ${result.limit})` : ` (cap ${result.limit})`) +
        `.`;

  return {
    symbols: [],
    clusters: [],
    processes: [],
    confidence: result.ok ? 1 : 0,
    riskLevel: "low",
    affectedFlows: [],
    summary,
    queryGraph: {
      ok: result.ok,
      rows: result.rows,
      rowCount: result.rowCount,
      limit: result.limit,
      truncated: result.truncated,
      ...(result.unsupported ? { unsupported: result.unsupported } : {}),
    },
  };
}
