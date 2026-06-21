/**
 * Task 4 — edge-existence claim verifier.
 *
 * Verifies "X {relation} Y" for one {@link ClaimRelation}
 * (calls/imports/inherits/implements/references) with a single parameterized
 * existence query over the directed edges between the two resolved endpoints.
 *
 *   - claimed edge present                       → CONFIRMED
 *   - absent                                     → REFUTED
 *   - absent CALLS but a REFERENCES edge exists  → UNCERTAIN (the call may be
 *       dynamic — the function is passed as a value / wired via a callback or DI)
 *
 * Read-only; never throws (an unresolved endpoint degrades to `uncertain`).
 */
import type { GraphAdapter } from "../../core/ports/persistence.js";
import type { RelationType } from "../../core/domain.js";
import { resolveSymbol } from "./symbol-resolver.js";
import {
  unresolvedAssessment,
  type ClaimAssessment,
  type ClaimRelation,
} from "./verify-claim-types.js";

/** Map a raw Cypher edge label (possibly prefixed, e.g. `tpc_CALLS`) to a RelationType. */
function edgeLabelToRelType(label: string): RelationType {
  const bare = label.includes("_") ? label.slice(label.lastIndexOf("_") + 1) : label;
  switch (bare.toUpperCase()) {
    case "CALLS": return "calls";
    case "IMPORTS": return "imports";
    case "INHERITS": return "inherits";
    case "IMPLEMENTS": return "implements";
    case "CONTAINS": return "contains";
    case "REFERENCES": return "references";
    case "DEFINES": return "defines";
    case "DEPENDS_ON": return "dependsOn";
    case "OVERRIDES": return "overrides";
    case "METHODIMPLEMENTS": return "methodImplements";
    default: return "references";
  }
}

/** Fetch the distinct directed edge relation types from `fromId` to `toId`. */
async function edgesBetween(
  graph: GraphAdapter,
  fromId: string,
  toId: string,
): Promise<Set<RelationType>> {
  // NOTE: `label(e)` (not `type(e)`) — this backend has no `type()` function and
  // returns the (prefixed) relationship label, which edgeLabelToRelType strips.
  const rows = await graph.runCypher<{ edgeType: string }>(
    `MATCH (a:Symbol)-[e]->(b:Symbol)
     WHERE a.id = $from AND b.id = $to
     RETURN DISTINCT label(e) AS edgeType`,
    { from: fromId, to: toId },
  ) ?? [];
  return new Set(rows.filter((r) => r?.edgeType).map((r) => edgeLabelToRelType(r.edgeType)));
}

/**
 * Verify an edge-existence claim ("X {relation} Y").
 */
export async function verifyEdge(
  from: string,
  to: string,
  relation: ClaimRelation,
  graph: GraphAdapter,
): Promise<ClaimAssessment> {
  const fromRes = await resolveSymbol(from, graph);
  if (fromRes.kind === "not_found") return unresolvedAssessment("Source", from, fromRes);
  const toRes = await resolveSymbol(to, graph);
  if (toRes.kind === "not_found") return unresolvedAssessment("Target", to, toRes);

  const present = await edgesBetween(graph, fromRes.node.id, toRes.node.id);

  if (present.has(relation)) {
    return {
      verdict: "confirmed",
      reason: `A '${relation}' edge exists from '${from}' to '${to}'.`,
      evidence: [`${from} -[${relation}]-> ${to}`],
      basis: "presence",
      dynamicReachable: false,
    };
  }

  const others = [...present];
  const existingNote =
    others.length > 0
      ? `Existing edges from '${from}' to '${to}': ${others.join(", ")}.`
      : `No edges from '${from}' to '${to}'.`;

  // A claimed CALLS that is absent but where the source REFERENCES the target is
  // unprovable: the function may be invoked dynamically (callback / DI / value).
  const dynamicReachable = relation === "calls" && present.has("references");

  return {
    verdict: dynamicReachable ? "uncertain" : "refuted",
    reason: dynamicReachable
      ? `No direct '${relation}' edge from '${from}' to '${to}', but '${from}' REFERENCES '${to}' — the call may be dynamic (callback / DI).`
      : `No '${relation}' edge from '${from}' to '${to}'. ${existingNote}`,
    evidence: [existingNote],
    basis: "absence",
    dynamicReachable,
  };
}
