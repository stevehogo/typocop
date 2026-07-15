import { describe, it, expect } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { pdgQuery } from "./pdg-query.js";

function graphWith(rowsByMatch: (q: string) => Record<string, string>[]): GraphAdapter {
  return {
    createNode: async () => {}, createRelationship: async () => {},
    queryNodes: async () => [], queryRelationships: async () => [],
    deleteNodesByLabel: async () => 0, deleteRelationshipsByType: async () => 0,
    runCypher: (async <T,>(q: string) => rowsByMatch(q) as unknown as T[]) as GraphAdapter["runCypher"],
    runCypherWrite: async () => {},
  };
}

describe("pdgQuery", () => {
  it("mode=controls returns the CDG/CFG edges for the target's blocks", async () => {
    const g = graphWith((q) => q.includes("CDG") || q.includes("CFG")
      ? [{ from: "fn#1", to: "fn#2", edge: "cdg", branchSense: "T" }] : []);
    const res = await pdgQuery(g, { mode: "controls", target: "fn" });
    expect(res.mode).toBe("controls");
    expect(res.rows.length).toBe(1);
    expect(res.summary).toMatch(/control/i);
  });

  it("mode=flows returns the taint findings reaching the target sink", async () => {
    const g = graphWith((q) => q.includes("TaintFinding")
      ? [{ id: "taint:1", sinkKind: "command", sinkId: "fn", sanitized: "false" }] : []);
    const res = await pdgQuery(g, { mode: "flows", target: "fn" });
    expect(res.mode).toBe("flows");
    expect(res.rows[0]?.sinkKind).toBe("command");
  });

  it("empty result yields a clear summary, never throws", async () => {
    const res = await pdgQuery(graphWith(() => []), { mode: "controls", target: "nope" });
    expect(res.rows).toHaveLength(0);
    expect(res.summary).toMatch(/no /i);
  });
});
