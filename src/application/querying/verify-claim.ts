/**
 * Task 7 — `verify_claim` orchestrator (Grounding API, anti-hallucination).
 *
 * Pipeline: parse → dispatch by claim kind → grade → assemble. Every path is
 * wrapped so the tool degrades to an `uncertain` verdict — it NEVER throws to
 * the agent (an invalid claim, an unresolved symbol, an internal error, or a
 * timeout all become a graceful `uncertain` with a reason).
 *
 * Read-only orchestration of existing machinery (resolveSymbol, CALLS/IMPORTS/…
 * edges, trace-path reachability, the honest-uncertainty grader). No new infra.
 */
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { withQueryTimeout } from "../../platform/utils/limits.js";
import {
  parseClaim,
  gradeVerdict,
  type Claim,
  type ClaimAssessment,
  type ClaimVerdict,
} from "./verify-claim-types.js";
import { verifyUsage } from "./verify-usage.js";
import { verifyEdge } from "./verify-edge.js";
import { verifyReachability } from "./verify-reach.js";

/**
 * Verification budget. Generous (a few seconds) since reachability runs a
 * bounded BFS; on elapse the claim degrades to `uncertain` rather than hanging.
 */
export const VERIFY_CLAIM_TIMEOUT_MS = 15_000;

/** Result of {@link executeVerifyClaim}: the parsed claim (or null) + the verdict. */
export interface VerifyClaimResult {
  /** The parsed claim, or null when the input failed to parse. */
  readonly claim: Claim | null;
  readonly verdict: ClaimVerdict;
}

/** Build a standalone `uncertain` verdict (parse error / internal failure). */
function uncertain(reason: string): ClaimVerdict {
  return { verdict: "uncertain", confidence: 0.5, reason, evidence: [] };
}

/** Dispatch a parsed claim to the right verifier, producing a raw assessment. */
function assess(claim: Claim, graph: GraphAdapter): Promise<ClaimAssessment> {
  switch (claim.kind) {
    case "usage":
      return verifyUsage(claim.symbol, graph);
    case "edge":
      return verifyEdge(claim.from, claim.to, claim.relation, graph);
    case "reachability":
      return verifyReachability(claim.from, claim.to, claim.polarity, graph);
  }
}

/**
 * Verify a structured claim about the codebase. Returns a graded verdict +
 * confidence + evidence; degrades to `uncertain` on every failure path.
 */
export async function executeVerifyClaim(
  params: Record<string, unknown>,
  graph: GraphAdapter,
  timeoutMs: number = VERIFY_CLAIM_TIMEOUT_MS,
): Promise<VerifyClaimResult> {
  const parsed = parseClaim(params);
  if (!parsed.ok) {
    return { claim: null, verdict: uncertain(`Invalid claim: ${parsed.error}`) };
  }

  try {
    const assessment = await withQueryTimeout(() => assess(parsed.claim, graph), timeoutMs);
    return { claim: parsed.claim, verdict: gradeVerdict(assessment) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = /timeout/i.test(message);
    return {
      claim: parsed.claim,
      verdict: uncertain(
        timedOut
          ? `Could not verify the claim: verification timed out after ${timeoutMs}ms.`
          : `Could not verify the claim: ${message}.`,
      ),
    };
  }
}
