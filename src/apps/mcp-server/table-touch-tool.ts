/**
 * `what_reads_table` / `what_writes_table` MCP tools (Wave 8 · T4).
 *
 * Given a table name, list the code symbols that read from / write to it via the
 * persisted `READS_FROM_DB` / `WRITES_TO_DB` edges. Distinct from
 * `impact_analysis` / `find_dependents` (CALLS-keyed) — these key on the DATA
 * edges, answering "what code touches table X".
 *
 * Strictly read-only. DEGRADE-TO-EMPTY: when the data-touch pass did not run at
 * index time (or no symbol touches the resolved model) this returns a clear empty
 * result (`symbols: []`, low confidence, a "may be disabled" summary) — never an
 * error.
 */
import type { DatabaseAdapter } from "../../core/ports/persistence.js";
import type { MCPToolResponse } from "../../core/domain.js";
import { findTableTouchers, type TableTouchDirection } from "../../application/querying/table-touch.js";

/**
 * Execute a table-touch MCP tool. `direction` selects READS_FROM_DB vs
 * WRITES_TO_DB; shared by `what_reads_table` (`reads`) and `what_writes_table`
 * (`writes`).
 */
export async function executeTableTouch(
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
  direction: TableTouchDirection,
): Promise<MCPToolResponse> {
  const table = typeof params.table === "string" ? params.table : "";
  const maxResults = typeof params.maxResults === "number" ? params.maxResults : undefined;

  const graph = adapter.getGraphAdapter();
  const result = await findTableTouchers(graph, table, direction, {
    ...(maxResults ? { maxResults } : {}),
  });

  const verb = direction === "reads" ? "read from" : "write to";
  const shown = result.touchers.length;
  const cappedNote = result.totalFound > shown ? ` (showing first ${shown} of ${result.totalFound})` : "";
  const summary = shown === 0
    ? `No code found that ${verb} table '${result.table}' (data-touch indexing may be disabled, or the table is not modelled).`
    : `Found ${result.totalFound} symbol${result.totalFound === 1 ? "" : "s"} that ${verb} table '${result.table}'${cappedNote}.`;

  return {
    symbols: result.touchers.map((t) => ({
      id: t.symbol.id,
      name: t.symbol.name,
      kind: t.symbol.kind,
      location: { filePath: t.symbol.location.filePath, startLine: t.symbol.location.startLine },
      relationship: direction === "reads" ? "reads-table" : "writes-table",
      ...(t.confidence !== undefined ? { edgeConfidence: t.confidence } : {}),
    })),
    clusters: [],
    processes: [],
    confidence: shown === 0 ? 0.3 : 0.8,
    riskLevel: "low",
    affectedFlows: [],
    summary,
    tableTouch: {
      table: result.table,
      direction: result.direction,
      touchers: result.touchers.map((t) => ({
        symbolId: t.symbol.id,
        ...(t.confidence !== undefined ? { confidence: t.confidence } : {}),
        ...(t.reason ? { reason: t.reason } : {}),
      })),
      totalFound: result.totalFound,
    },
  };
}
