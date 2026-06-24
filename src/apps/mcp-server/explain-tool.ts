/**
 * `explain` MCP tool (Plan E, source task #8). Read-only.
 *
 * Renders TaintFindings for humans (source→sink, SinkKind, sanitized) and ALWAYS
 * carries the soundness caveat — these are heuristic, sound-but-over-reporting
 * findings: verify before acting; NEVER auto-act.
 */
import type { DatabaseAdapter } from "../../core/ports/persistence.js";
import type { MCPToolResponse, RiskLevel } from "../../core/domain.js";
import { explainFindings } from "../../application/querying/explain.js";

export async function executeExplain(
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
): Promise<MCPToolResponse> {
  const target = typeof params.target === "string" ? params.target : undefined;
  const limit = typeof params.limit === "number" ? params.limit : undefined;
  const result = await explainFindings(adapter.getGraphAdapter(), {
    ...(target ? { target } : {}), ...(limit ? { limit } : {}),
  });
  // Any unsanitized command/sql/code finding is the highest concern, but the tool
  // is advisory only — riskLevel reflects presence, never an action directive.
  const hasUnsanitized = result.findings.some((f) => !f.sanitized);
  const riskLevel: RiskLevel = hasUnsanitized ? "medium" : "low";
  return {
    symbols: [], clusters: [], processes: [],
    confidence: 0.6, riskLevel, affectedFlows: [],
    summary: result.summary,
  };
}
