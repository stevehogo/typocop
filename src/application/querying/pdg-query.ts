/**
 * `pdg_query` query logic (Plan E, source task #8).
 *
 * Read-only. `mode:"controls"` returns the control-dependence + control-flow
 * edges among a target callable's basic blocks (the per-function PDG slice);
 * `mode:"flows"` returns the taint findings whose sink is that callable. Uses
 * BARE labels/edge-types through `runCypher` (the adapter prefixes them). Never
 * mutates; never throws on an unknown target (empty result + a clear summary).
 */
import type { GraphAdapter } from "../../core/ports/persistence.js";

export type PdgQueryMode = "controls" | "flows";
export interface PdgQueryResult {
  readonly mode: PdgQueryMode;
  readonly target: string;
  readonly rows: readonly Record<string, string>[];
  readonly summary: string;
}

export async function pdgQuery(
  graph: GraphAdapter,
  opts: { mode: PdgQueryMode; target: string },
): Promise<PdgQueryResult> {
  const { mode, target } = opts;
  if (mode === "controls") {
    // CDG + CFG edges among blocks owned by the target callable (matched by the
    // BasicBlock.functionId prefix). HasBlock anchors blocks to the Symbol.
    const rows = await graph.runCypher<Record<string, string>>(
      `MATCH (s:Symbol)-[:HAS_BLOCK]->(b:BasicBlock)
       WHERE s.id = $t OR s.name = $t
       OPTIONAL MATCH (b)-[c:CDG]->(b2:BasicBlock)
       OPTIONAL MATCH (b)-[g:CFG]->(b3:BasicBlock)
       RETURN b.id AS block, b2.id AS cdgTo, c.branchSense AS branchSense, b3.id AS cfgTo, g.edgeKind AS edgeKind`,
      { t: target },
    ) ?? [];
    return {
      mode, target, rows,
      summary: rows.length === 0
        ? `No control-dependence/control-flow blocks found for '${target}' (was the graph indexed with --pdg?).`
        : `Control structure for '${target}': ${rows.length} block edge row(s) (CDG + CFG).`,
    };
  }
  // flows
  const rows = await graph.runCypher<Record<string, string>>(
    `MATCH (f:TaintFinding)-[:TAINT_SINK]->(s:Symbol)
     WHERE s.id = $t OR s.name = $t
     RETURN f.id AS id, f.sinkKind AS sinkKind, f.sourceLoc AS sourceLoc, f.sinkLoc AS sinkLoc, f.sanitized AS sanitized
     ORDER BY f.sinkKind, f.sinkLoc`,
    { t: target },
  ) ?? [];
  return {
    mode, target, rows,
    summary: rows.length === 0
      ? `No taint flows reach '${target}' (was the graph indexed with --pdg?).`
      : `Taint flows into '${target}': ${rows.length} finding(s).`,
  };
}
