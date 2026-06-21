/**
 * Task 3 — usage/dead-code claim verifier.
 *
 * Verifies a "X has no callers" / "X is dead" claim by reusing the dead-code
 * logic (D6): a symbol with no incoming CALLS edge that is neither exported nor
 * entry-point-named is a dead candidate. Reuses {@link resolveSymbol} and the
 * shared {@link isEntryPointName} heuristic.
 *
 *   - callers exist                          → REFUTED (counterexample = caller set = trueAnswer)
 *   - no callers, exported / entry-point     → UNCERTAIN (may be invoked externally / dynamically)
 *   - no callers, private & not entry-point  → CONFIRMED (appears dead)
 *
 * Read-only; never throws to the caller (an unresolved symbol degrades to a
 * graceful `uncertain` carrying the resolver's suggestions).
 */
import type { GraphAdapter } from "../../core/ports/persistence.js";
import type { Symbol } from "../../core/domain.js";
import { resolveSymbol } from "./symbol-resolver.js";
import { graphNodeToSymbol } from "./graph-helpers.js";
import { isEntryPointName } from "../../platform/utils/entry-point-names.js";
import { unresolvedAssessment, type ClaimAssessment } from "./verify-claim-types.js";

/** Mirror of dead-code.ts isExported — part of the public surface (no in-repo caller required). */
function isExported(symbol: Symbol): boolean {
  return symbol.visibility === "public" || symbol.kind === "export";
}

/** One incoming caller of the target (id + display name). */
interface CallerRow {
  callerId: string;
  callerName: string;
}

/** Find the DIRECT incoming CALLS callers of a resolved symbol id. */
async function findCallers(graph: GraphAdapter, symbolId: string): Promise<CallerRow[]> {
  const rows = await graph.runCypher<CallerRow>(
    `MATCH (caller:Symbol)-[:CALLS]->(t:Symbol)
     WHERE t.id = $val
     RETURN DISTINCT caller.id AS callerId, caller.name AS callerName`,
    { val: symbolId },
  ) ?? [];
  return rows.filter((r): r is CallerRow => Boolean(r?.callerId));
}

/**
 * Verify a usage/dead-code claim ("X has no callers" / "X is dead").
 */
export async function verifyUsage(symbol: string, graph: GraphAdapter): Promise<ClaimAssessment> {
  const resolution = await resolveSymbol(symbol, graph);
  if (resolution.kind === "not_found") {
    return unresolvedAssessment("Symbol", symbol, resolution);
  }

  const sym = graphNodeToSymbol(resolution.node);
  const callers = await findCallers(graph, resolution.node.id);

  if (callers.length > 0) {
    const names = callers.map((c) => c.callerName);
    return {
      verdict: "refuted",
      reason:
        `'${sym.name}' is NOT dead: it has ${callers.length} in-repo caller` +
        `${callers.length === 1 ? "" : "s"} via CALLS edges.`,
      evidence: names,
      counterexample: `Called by: ${names.join(", ")}.`,
      trueAnswer: `'${sym.name}' is called by ${callers.length} symbol${callers.length === 1 ? "" : "s"}: ${names.join(", ")}.`,
      basis: "presence",
      dynamicReachable: false,
    };
  }

  // No incoming CALLS edges. Decide whether that proves death.
  const exported = isExported(sym);
  const entryPoint = isEntryPointName(sym.name);
  if (exported || entryPoint) {
    const why = exported
      ? "it is exported (part of the public surface)"
      : "its name matches an entry-point pattern (framework/runtime-invoked)";
    return {
      verdict: "uncertain",
      reason: `'${sym.name}' has no in-repo CALLS callers, but ${why}, so it may be invoked externally or via dynamic dispatch.`,
      evidence: ["No incoming CALLS edges found.", exported ? "exported" : "entry-point-named"],
      basis: "absence",
      dynamicReachable: true,
    };
  }

  return {
    verdict: "confirmed",
    reason: `'${sym.name}' has no incoming CALLS edges and is neither exported nor entry-point-named — it appears dead.`,
    evidence: ["No incoming CALLS edges found.", "Not exported, not entry-point-named."],
    basis: "absence",
    dynamicReachable: false,
  };
}
