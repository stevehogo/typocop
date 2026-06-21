/**
 * Task 5 — reachability/independence claim verifier.
 *
 * Reuses {@link executeTracePath} (D3, clamped BFS over CALLS|CONTAINS) to find
 * the shortest hop chain from `from` to `to`, then interprets it per polarity:
 *
 *   reachable   — path found → CONFIRMED (evidence = hop chain)
 *               — no path    → REFUTED   (no static path within depth)
 *   independent — path found → REFUTED   (counterexample = the hop path)
 *               — no path    → UNCERTAIN (absence of a static path does NOT
 *                                         prove independence — honest-uncertainty)
 *
 * Read-only; never throws (an unresolved endpoint degrades to `uncertain`).
 */
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { executeTracePath, type TraceHop } from "./trace-path.js";
import {
  unresolvedAssessment,
  type ClaimAssessment,
  type ReachabilityPolarity,
} from "./verify-claim-types.js";

/** Render a hop chain `a -[calls]-> b -[contains]-> c` for evidence/counterexamples. */
function renderChain(hops: readonly TraceHop[]): string {
  return hops
    .map((h, i) => (i < hops.length - 1 ? `${h.name} -[${h.edgeToNext}]->` : h.name))
    .join(" ");
}

/**
 * Verify a reachability/independence claim.
 */
export async function verifyReachability(
  from: string,
  to: string,
  polarity: ReachabilityPolarity,
  graph: GraphAdapter,
): Promise<ClaimAssessment> {
  const result = await executeTracePath(from, to, undefined, graph);
  const { from: fromRes, to: toRes } = result.resolution;
  if (fromRes.kind === "not_found") return unresolvedAssessment("Source", from, fromRes);
  if (toRes.kind === "not_found") return unresolvedAssessment("Target", to, toRes);

  if (polarity === "reachable") {
    if (result.found) {
      const chain = renderChain(result.hops);
      return {
        verdict: "confirmed",
        reason: `'${from}' can reach '${to}' in ${result.length} hop${result.length === 1 ? "" : "s"}: ${chain}.`,
        evidence: [chain],
        basis: "presence",
        dynamicReachable: false,
      };
    }
    return {
      verdict: "refuted",
      reason:
        `No static CALLS/CONTAINS path from '${from}' to '${to}' within the search depth. ` +
        `(Dynamic dispatch / callbacks / DI are not tracked.)`,
      evidence: ["No static path found within the search depth."],
      basis: "absence",
      dynamicReachable: false,
    };
  }

  // polarity === "independent" — "changing X can't affect Y".
  if (result.found) {
    const chain = renderChain(result.hops);
    return {
      verdict: "refuted",
      reason: `'${from}' and '${to}' are NOT independent — '${from}' reaches '${to}': ${chain}.`,
      evidence: [chain],
      counterexample: `Path: ${chain}.`,
      trueAnswer: `'${from}' reaches '${to}' in ${result.length} hop${result.length === 1 ? "" : "s"}: ${chain}.`,
      basis: "presence",
      dynamicReachable: false,
    };
  }
  return {
    verdict: "uncertain",
    reason:
      `No static CALLS/CONTAINS path from '${from}' to '${to}' was found, but absence of a path does ` +
      `NOT prove independence — dynamic dispatch / callbacks / DI are not tracked.`,
    evidence: ["No static path found within the search depth."],
    basis: "absence",
    dynamicReachable: false,
  };
}
