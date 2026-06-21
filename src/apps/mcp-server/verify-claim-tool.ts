/**
 * `verify_claim` MCP tool (Grounding API, anti-hallucination).
 *
 * An agent submits a structured claim about the codebase (usage / edge /
 * reachability) and gets back a verdict (confirmed / refuted / uncertain) +
 * confidence + evidence — so it stops acting on false beliefs ("nothing calls
 * X, safe to delete"). The verdict rides the ADDITIVE optional `verdict` field
 * of {@link MCPToolResponse}; a one-line `summary` digests it for AI editors.
 *
 * Read-only orchestration of existing machinery; degrades to `uncertain` — it
 * never throws to the agent.
 */
import type { DatabaseAdapter } from "../../core/ports/persistence.js";
import type { MCPToolResponse } from "../../core/domain.js";
import { executeVerifyClaim, type VerifyClaimResult } from "../../application/querying/verify-claim.js";

/** Build the one-line `summary` digest from a verdict result. */
export function buildVerifyClaimSummary(result: VerifyClaimResult): string {
  const { claim, verdict } = result;
  const pct = `${Math.round(verdict.confidence * 100)}%`;
  const kind = claim ? claim.kind : "claim";
  const head = `Claim (${kind}): ${verdict.verdict.toUpperCase()} (confidence ${pct}). ${verdict.reason}`;
  if (verdict.verdict === "refuted" && verdict.trueAnswer) {
    return `${head} True answer: ${verdict.trueAnswer}`;
  }
  if (verdict.counterexample) {
    return `${head} Counterexample: ${verdict.counterexample}`;
  }
  return head;
}

/**
 * Execute the `verify_claim` MCP tool.
 */
export async function executeVerifyClaimTool(
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
): Promise<MCPToolResponse> {
  const graph = adapter.getGraphAdapter();
  const result = await executeVerifyClaim(params, graph);
  const { claim, verdict } = result;

  return {
    symbols: [],
    clusters: [],
    processes: [],
    confidence: verdict.confidence,
    riskLevel: "low",
    affectedFlows: [],
    summary: buildVerifyClaimSummary(result),
    verdict: {
      claimKind: claim ? claim.kind : "usage",
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      reason: verdict.reason,
      evidence: [...verdict.evidence],
      ...(verdict.counterexample !== undefined ? { counterexample: verdict.counterexample } : {}),
      ...(verdict.trueAnswer !== undefined ? { trueAnswer: verdict.trueAnswer } : {}),
    },
  };
}
