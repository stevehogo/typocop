/**
 * Grounding API — claim + verdict types and pure parse/grade helpers
 * (anti-hallucination). An agent submits a structured {@link Claim} about the
 * codebase; the verifiers return a {@link ClaimAssessment} (the honest
 * structural facts), which {@link gradeVerdict} turns into a final
 * {@link ClaimVerdict} (verdict + confidence + evidence).
 *
 * Read-only orchestration of existing machinery (resolveSymbol, CALLS/IMPORTS/…
 * edges, trace-path reachability). No new infra.
 *
 * Honest-uncertainty (D5) is mandatory: any relationship the graph cannot prove
 * (dynamic dispatch, callbacks, DI) MUST yield `uncertain` — never a false
 * confirm/refute. Verifiers route those cases to `uncertain`; {@link gradeVerdict}
 * re-asserts the invariant as defense-in-depth and is the single source of the
 * confidence score (philosophy mirrors {@link ./explainability.ts}).
 */
import type { RelationType } from "../../core/domain.js";
import type { SymbolResolution } from "./symbol-resolver.js";

/** Edge relations a v1 edge-existence claim may assert. */
export const CLAIM_EDGE_RELATIONS = [
  "calls",
  "imports",
  "inherits",
  "implements",
  "references",
] as const satisfies readonly RelationType[];

/** A relation usable in an edge claim (subset of {@link RelationType}). */
export type ClaimRelation = (typeof CLAIM_EDGE_RELATIONS)[number];

/** Reachability claim polarity. */
export type ReachabilityPolarity = "reachable" | "independent";

/**
 * A structured, verifiable claim about the codebase (D4 claim classes):
 *  - `usage`        — "X has no callers" / "X is dead".
 *  - `edge`         — "X {relation} Y" (calls/imports/inherits/implements/references).
 *  - `reachability` — "X can reach Y" (reachable) / "changing X can't affect Y" (independent).
 */
export type Claim =
  | { readonly kind: "usage"; readonly symbol: string }
  | { readonly kind: "edge"; readonly from: string; readonly to: string; readonly relation: ClaimRelation }
  | {
      readonly kind: "reachability";
      readonly from: string;
      readonly to: string;
      readonly polarity: ReachabilityPolarity;
    };

/** Discriminant of a {@link Claim}. */
export type ClaimKind = Claim["kind"];

/** The three possible answers — confirmed / refuted, or honest uncertainty. */
export type Verdict = "confirmed" | "refuted" | "uncertain";

/**
 * The honest structural assessment a verifier produces BEFORE grading. It states
 * the verdict the graph supports plus the signals {@link gradeVerdict} needs to
 * assign a confidence and enforce honest-uncertainty.
 */
export interface ClaimAssessment {
  /** Honest verdict chosen by the verifier from what the graph shows. */
  readonly verdict: Verdict;
  /** Human-readable explanation of the verdict. */
  readonly reason: string;
  /** Supporting facts (caller names, edge types, hop chain, suggestions…). */
  readonly evidence: readonly string[];
  /** A concrete counterexample to the claim (only on a refute). */
  readonly counterexample?: string;
  /** The actual answer to surface on a refute (OQ3): caller set, hop path, … */
  readonly trueAnswer?: string;
  /**
   * Whether the verdict rests on FINDING evidence (`presence`) or on NOT finding
   * it (`absence`). Absence-based verdicts are weaker and can be unprovable.
   */
  readonly basis: "presence" | "absence";
  /**
   * Whether a dynamic/unprovable relationship (dynamic dispatch, callback, DI,
   * external/exported invocation) could flip an absence-based verdict. When true
   * and basis is `absence`, the honest verdict is `uncertain`.
   */
  readonly dynamicReachable: boolean;
}

/** The final, graded answer returned to the agent. */
export interface ClaimVerdict {
  readonly verdict: Verdict;
  /** Confidence in the verdict, [0.0, 1.0]. */
  readonly confidence: number;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly counterexample?: string;
  readonly trueAnswer?: string;
}

/** Outcome of {@link parseClaim}. */
export type ParseClaimResult =
  | { readonly ok: true; readonly claim: Claim }
  | { readonly ok: false; readonly error: string };

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/**
 * Validate the discriminated {@link Claim} shape from raw MCP params. Pure — no
 * DB, no throws; returns a typed error string the caller turns into a graceful
 * `uncertain` verdict rather than crashing the agent.
 */
export function parseClaim(params: Record<string, unknown>): ParseClaimResult {
  const kind = asString(params.kind);
  if (!kind) {
    return { ok: false, error: "claim 'kind' is required (usage | edge | reachability)." };
  }

  switch (kind) {
    case "usage": {
      const symbol = asString(params.symbol);
      if (!symbol) return { ok: false, error: "usage claim requires a 'symbol' name." };
      return { ok: true, claim: { kind: "usage", symbol } };
    }
    case "edge": {
      const from = asString(params.from);
      const to = asString(params.to);
      const relation = asString(params.relation);
      if (!from || !to) return { ok: false, error: "edge claim requires 'from' and 'to' symbols." };
      if (!relation || !(CLAIM_EDGE_RELATIONS as readonly string[]).includes(relation)) {
        return {
          ok: false,
          error: `edge claim 'relation' must be one of: ${CLAIM_EDGE_RELATIONS.join(", ")}.`,
        };
      }
      return { ok: true, claim: { kind: "edge", from, to, relation: relation as ClaimRelation } };
    }
    case "reachability": {
      const from = asString(params.from);
      const to = asString(params.to);
      const polarity = asString(params.polarity);
      if (!from || !to) {
        return { ok: false, error: "reachability claim requires 'from' and 'to' symbols." };
      }
      if (polarity !== "reachable" && polarity !== "independent") {
        return {
          ok: false,
          error: "reachability claim 'polarity' must be 'reachable' or 'independent'.",
        };
      }
      return { ok: true, claim: { kind: "reachability", from, to, polarity } };
    }
    default:
      return { ok: false, error: `unknown claim kind '${kind}' (usage | edge | reachability).` };
  }
}

/**
 * Build a graceful `uncertain` assessment for an unresolved symbol, carrying the
 * resolver's "Did you mean?" suggestions (never a throw — Task 2).
 */
export function unresolvedAssessment(
  label: string,
  name: string,
  resolution: Extract<SymbolResolution, { kind: "not_found" }>,
): ClaimAssessment {
  const suggestions = resolution.suggestions;
  const didYouMean =
    suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : " No similar symbols found.";
  return {
    verdict: "uncertain",
    reason: `${label} '${name}' could not be resolved, so the claim cannot be verified.${didYouMean}`,
    evidence: suggestions,
    basis: "absence",
    dynamicReachable: false,
  };
}

/** Clamp a number into [0, 1] (mirrors explainability.ts). */
function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Grade an honest {@link ClaimAssessment} into a final {@link ClaimVerdict}
 * (D5, mandatory). Assigns the confidence score and ENFORCES honest-uncertainty:
 * an absence-based verdict that a dynamic/unprovable relationship could flip is
 * downgraded to `uncertain` — never a false confirm/refute.
 *
 * Confidence (philosophy ported from {@link ./explainability.ts}):
 *  - presence-based (found hard evidence)         → 0.95 (high trust)
 *  - absence-based, nothing suggests dynamic use  → 0.80 (no static evidence)
 *  - uncertain (dynamic-unprovable / no proof)    → 0.50 (honest)
 */
export function gradeVerdict(assessment: ClaimAssessment): ClaimVerdict {
  let verdict = assessment.verdict;
  let reason = assessment.reason;

  const unprovable = assessment.basis === "absence" && assessment.dynamicReachable;
  if (unprovable && verdict !== "uncertain") {
    verdict = "uncertain";
    reason =
      `${reason} The graph cannot prove this — dynamic dispatch, callbacks, or DI are not tracked — ` +
      `so the honest verdict is uncertain.`;
  }

  const confidence =
    verdict === "uncertain" ? 0.5 : assessment.basis === "presence" ? 0.95 : 0.8;

  return {
    verdict,
    confidence: clamp01(confidence),
    reason,
    evidence: assessment.evidence,
    ...(assessment.counterexample !== undefined ? { counterexample: assessment.counterexample } : {}),
    ...(assessment.trueAnswer !== undefined ? { trueAnswer: assessment.trueAnswer } : {}),
  };
}
