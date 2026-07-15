/**
 * `explain` query logic (Plan E, source task #8).
 *
 * Read-only. Renders TaintFindings for humans: each finding's source→sink, its
 * SinkKind, and whether a sanitizer was on the path. Carries the soundness
 * caveat in EVERY summary — these findings are sound-but-over-reporting (closures
 * /callbacks often invisible, field-level flows untracked, context-insensitive
 * name matching ⇒ expect false positives). NEVER auto-act on a finding; verify
 * first. Reference implementation: an open-source CFG/taint indexer.
 */
import type { GraphAdapter } from "../../core/ports/persistence.js";
import type { TaintFinding } from "../../core/domain.js";
import { graphNodeToTaintFinding } from "./graph-helpers.js";

/** A node-valued Cypher column as the adapter returns it: `{ labels, properties }`
 * (id lives in properties.id, per rowToNode); a mock may add a top-level id. */
interface RawNodeColumn { id?: string; labels?: string[]; properties?: Record<string, string> }

export const TAINT_SOUNDNESS_CAVEAT =
  "Taint findings are heuristic (sound-but-over-reporting): closures/callbacks, " +
  "field-level flows, and dynamic dispatch may be missed or mis-attributed — expect " +
  "false positives. Verify each finding before acting; never auto-act.";

export interface ExplainResult {
  readonly findings: readonly TaintFinding[];
  readonly summary: string;
}

export async function explainFindings(
  graph: GraphAdapter,
  opts: { target?: string; limit?: number } = {},
): Promise<ExplainResult> {
  const limit = opts.limit !== undefined && opts.limit > 0 ? opts.limit : 50;
  const cypher = opts.target
    ? `MATCH (f:TaintFinding)-[:TAINT_SINK]->(s:Symbol)
       WHERE s.id = $t OR s.name = $t
       RETURN f ORDER BY f.sinkKind, f.sinkLoc LIMIT $lim`
    : `MATCH (f:TaintFinding)
       RETURN f ORDER BY f.sinkKind, f.sinkLoc LIMIT $lim`;
  const rows = await graph.runCypher<{ f: RawNodeColumn }>(cypher, { lim: limit, ...(opts.target ? { t: opts.target } : {}) }) ?? [];
  // Normalize the node-valued `f` column to a GraphNode (id from properties.id,
  // like rowToNode). Slice to `limit` as a defensive bound (the Cypher LIMIT is
  // authoritative on a real adapter; this keeps the cap honoured if one ignores it).
  const findings = rows
    .map((r) => graphNodeToTaintFinding({
      id: r.f.properties?.id ?? r.f.id ?? "",
      labels: r.f.labels ?? ["TaintFinding"],
      properties: r.f.properties ?? {},
    }))
    .slice(0, limit);

  if (findings.length === 0) {
    return { findings, summary: `No taint findings${opts.target ? ` for '${opts.target}'` : ""}. ${TAINT_SOUNDNESS_CAVEAT}` };
  }
  const lines = findings.map((f, i) =>
    `${i + 1}. [${f.sinkKind}${f.sanitized ? ", sanitized" : ""}] ${f.sourceLoc} → ${f.sinkLoc}`,
  );
  return {
    findings,
    summary:
      `${findings.length} taint finding(s)${opts.target ? ` reaching '${opts.target}'` : ""}:\n` +
      `${lines.join("\n")}\n\n${TAINT_SOUNDNESS_CAVEAT}`,
  };
}
