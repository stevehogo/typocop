import { describe, it, expect } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { explainFindings, TAINT_SOUNDNESS_CAVEAT } from "./explain.js";

function graphWithFindings(rows: Record<string, string>[]): GraphAdapter {
  return {
    createNode: async () => {}, createRelationship: async () => {},
    queryNodes: async () => [], queryRelationships: async () => [],
    deleteNodesByLabel: async () => 0, deleteRelationshipsByType: async () => 0,
    runCypher: (async <T,>() => rows.map((r) => ({ f: { id: r.id, labels: ["TaintFinding"], properties: r } })) as unknown as T[]) as GraphAdapter["runCypher"],
    runCypherWrite: async () => {},
  };
}

describe("explainFindings", () => {
  // sourceId/sinkId are the owning callable's real (colon-laden) Symbol.id
  // (symbol-id.ts:20 `${filePath}:${name}:${line}:${col}`) — a realistic id here
  // guards against anyone reintroducing a `split(":")` owner-extraction.
  const finding = {
    id: "taint:1", sinkKind: "command",
    sourceId: "src/inject.ts:handler:3:2", sinkId: "src/inject.ts:handler:4:2",
    sourceLoc: "inject.ts:3", sinkLoc: "inject.ts:4", sanitized: "false", pathJson: '["fn#0","fn#1"]',
  };

  it("renders a finding's source→sink + sinkKind and carries the soundness caveat", async () => {
    const res = await explainFindings(graphWithFindings([finding]));
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]?.sinkKind).toBe("command");
    expect(res.summary).toContain("inject.ts:3");
    expect(res.summary).toContain("inject.ts:4");
    expect(res.summary).toContain(TAINT_SOUNDNESS_CAVEAT);
    expect(TAINT_SOUNDNESS_CAVEAT).toMatch(/never auto-act/i);
  });

  it("honours limit and reports a clean summary when there are none", async () => {
    const empty = await explainFindings(graphWithFindings([]));
    expect(empty.findings).toHaveLength(0);
    expect(empty.summary).toMatch(/no taint/i);

    const many = await explainFindings(graphWithFindings([finding, { ...finding, id: "taint:2" }]), { limit: 1 });
    expect(many.findings).toHaveLength(1);
  });
});
