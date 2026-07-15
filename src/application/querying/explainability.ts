/**
 * Impact-analysis explainability (D2).
 *
 * Pure (no DB, no I/O) helpers that turn the raw structural facts about an
 * affected node — its hop-1 in/out degree, export status, the first-hop edge
 * that pulled it into the blast radius, and its hop distance — into an
 * explainable {@link AffectedNodeExplanation}: a {@link NodeRole}, a confidence
 * score, and human-readable `reasons[]`.
 *
 * Implements the node-role + confidence rules. Kept side-effect-free so the
 * impact-analysis query layer can call it once per affected node after it has
 * gathered the degree aggregate.
 *
 * Requirements: 10.x explainability (additive to impact analysis).
 */
import type { NodeRole, RelationType } from "../../core/domain.js";

export type { NodeRole };

/** Per-affected-node explanation attached to an impact-analysis result. */
export interface AffectedNodeExplanation {
  /** Persisted symbol id (logicalKey) of the affected node. */
  readonly symbolId: string;
  /** Structural role classification. */
  readonly nodeRole: NodeRole;
  /** Edge type of the first hop that pulled this node into the blast radius. */
  readonly entryEdge: RelationType;
  /** Number of edges from the target to this node (1 = direct caller). */
  readonly hopDistance: number;
  /** Confidence in this node being genuinely affected, [0.0, 1.0]. */
  readonly confidence: number;
  /** Human-readable reasons explaining the role/confidence. */
  readonly reasons: string[];
}

/** Hop-1 connectivity + export status used to classify a node. */
export interface NodeDegree {
  /** Count of distinct nodes that directly call/reference this node (incoming). */
  readonly inDegree: number;
  /** Count of distinct nodes this node directly calls/references (outgoing). */
  readonly outDegree: number;
  /** Whether the node is exported (visible outside its module). */
  readonly isExported: boolean;
}

/**
 * Classify a node's structural role from its hop-1 in/out degree.
 *
 * Rules:
 * - (in 0, out 0)            → Isolated   (no detected connections)
 * - (in 0, out > 0)          → EntryPoint (nothing calls it; it drives others)
 * - (in > 0, out 0)          → Utility    (leaf helper, called by others)
 * - (in > 0, out > 0) skewed → Adapter    (few callers ↔ many callees, or vice versa)
 * - (in > 0, out > 0) else   → CoreLogic
 *
 * `isExported` does not change the four-way connectivity classification but is
 * carried through to {@link explainAffectedNode} for the reasons digest and to
 * temper the isolated-node confidence (an exported isolated symbol may be a
 * public entry called from outside the indexed graph).
 */
export function classifyNodeRole(degree: NodeDegree): NodeRole {
  const hasIn = degree.inDegree > 0;
  const hasOut = degree.outDegree > 0;

  if (!hasIn && !hasOut) return "Isolated";
  if (!hasIn && hasOut) return "EntryPoint";
  if (hasIn && !hasOut) return "Utility";

  // Both connected: distinguish adapter (skewed degree) from core logic.
  const { inDegree, outDegree } = degree;
  const skewed =
    (inDegree <= 2 && outDegree > 5) || (outDegree <= 2 && inDegree > 5);
  return skewed ? "Adapter" : "CoreLogic";
}

/** Clamp a number into the [0, 1] range. */
function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Build the full explanation (role + confidence + reasons) for a single
 * affected node, given how it entered the blast radius and its connectivity.
 *
 * Confidence:
 * - direct callers (hopDistance 1) start high; confidence decays with distance
 *   (each extra hop adds uncertainty about whether the change truly propagates);
 * - an edge-backed entry (`calls`/`references`/`imports`) is more trustworthy
 *   than a structural/containment edge;
 * - an Isolated node is low-confidence (it appears unaffected / dynamically
 *   reached), unless it is exported (could be called from outside the graph).
 */
export function explainAffectedNode(input: {
  readonly symbolId: string;
  readonly entryEdge: RelationType;
  readonly hopDistance: number;
  readonly degree: NodeDegree;
}): AffectedNodeExplanation {
  const { symbolId, entryEdge, hopDistance, degree } = input;
  const nodeRole = classifyNodeRole(degree);
  const reasons: string[] = [];

  // ── Base confidence from hop distance ──────────────────────────────────────
  // 1 hop → 0.95 (will break immediately); decays ~0.12 per extra hop.
  const hops = Math.max(1, hopDistance);
  let confidence = 0.95 - (hops - 1) * 0.12;
  if (hopDistance <= 1) {
    reasons.push("Direct caller — breaks immediately if the target changes");
  } else {
    reasons.push(`${hopDistance} hops from the target (transitive impact)`);
  }

  // ── Entry-edge trust ───────────────────────────────────────────────────────
  const strongEdge =
    entryEdge === "calls" || entryEdge === "references" || entryEdge === "imports";
  if (strongEdge) {
    reasons.push(`Reached via a '${entryEdge}' edge`);
  } else {
    confidence -= 0.1;
    reasons.push(`Reached via a structural '${entryEdge}' edge (weaker signal)`);
  }

  // ── Role-specific adjustments + reasons ─────────────────────────────────────
  switch (nodeRole) {
    case "Isolated":
      confidence -= degree.isExported ? 0.15 : 0.35;
      reasons.push(
        degree.isExported
          ? "Appears isolated but is exported — may be called from outside the indexed graph"
          : "Appears isolated (no detected connections) — verify dynamic/external use",
      );
      break;
    case "EntryPoint":
      reasons.push(
        `Entry point (no internal callers, ${degree.outDegree} downstream ${degree.outDegree === 1 ? "dependency" : "dependencies"})`,
      );
      break;
    case "Utility":
      reasons.push(
        `Utility (called by ${degree.inDegree} ${degree.inDegree === 1 ? "node" : "nodes"}, no outgoing dependencies)`,
      );
      break;
    case "Adapter":
      reasons.push(
        `Adapter — skewed connectivity (${degree.inDegree} in / ${degree.outDegree} out) bridging layers`,
      );
      break;
    case "CoreLogic":
      reasons.push(
        `Core logic — well-connected (${degree.inDegree} callers, ${degree.outDegree} dependencies)`,
      );
      break;
  }

  if (degree.isExported && nodeRole !== "Isolated") {
    reasons.push("Exported — changes are visible across module boundaries");
  }

  return {
    symbolId,
    nodeRole,
    entryEdge,
    hopDistance,
    confidence: clamp01(confidence),
    reasons,
  };
}
