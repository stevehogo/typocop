/**
 * `pdg_query` MCP tool (Plan E, source task #8). Read-only.
 *
 * `mode:"controls"` → the target callable's control-dependence/control-flow
 * block structure; `mode:"flows"` → the taint findings whose sink is the target.
 * Requires the graph to have been indexed with `--pdg` (else empty + a hint).
 */
import type { DatabaseAdapter } from "../../core/ports/persistence.js";
import type { MCPToolResponse } from "../../core/domain.js";
import { pdgQuery, type PdgQueryMode } from "../../application/querying/pdg-query.js";

export async function executePdgQuery(
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
): Promise<MCPToolResponse> {
  const mode = (params.mode === "flows" ? "flows" : "controls") as PdgQueryMode;
  const target = typeof params.target === "string" ? params.target : "";
  const result = await pdgQuery(adapter.getGraphAdapter(), { mode, target });
  return {
    symbols: [], clusters: [], processes: [],
    confidence: 0.6, riskLevel: "low", affectedFlows: [],
    summary: result.summary,
  };
}
