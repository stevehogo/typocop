/**
 * D2 — entryEdge + hopDistance correctness on a small fixture graph,
 * exercising executeImpactAnalysis's resolved-symbol path with mocked Cypher.
 *
 * runCypher call order on the symbol path:
 *   1. exact-match lookup          -> target node
 *   2. findDependents (CALLS*)     -> all transitive dependents
 *   3. findProcessesBySymbol       -> []
 *   4. findClustersBySymbol        -> []
 *   5. findDirectCallers           -> 1-hop callers + edge type
 *   6. fetchDegrees                -> batched hop-1 degree aggregate
 */
import { describe, expect, it, vi } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { executeImpactAnalysis } from "./impact-analysis.js";

function symbolRow(id: string, props: Record<string, string> = {}) {
  return {
    n: {
      labels: ["Symbol"],
      properties: {
        id,
        name: id,
        kind: "function",
        filePath: `/repo/${id}.ts`,
        startLine: "1",
        startColumn: "0",
        endLine: "5",
        endColumn: "0",
        visibility: "public",
        ...props,
      },
    },
  };
}

function makeAdapter(responses: unknown[][]): GraphAdapter {
  let index = 0;
  return {
    createNode: vi.fn(),
    createRelationship: vi.fn(),
    queryNodes: vi.fn(),
    queryRelationships: vi.fn(),
    deleteNodesByLabel: vi.fn(),
    deleteRelationshipsByType: vi.fn(),
    runCypher: vi.fn().mockImplementation(() => Promise.resolve(responses[index++] ?? [])),
    runCypherWrite: vi.fn(),
  };
}

describe("executeImpactAnalysis — D2 explainability", () => {
  it("marks direct callers hop 1 with their edge type and transitive ones hop 2", async () => {
    // Graph: target <-CALLS- direct1 ; target <-REFERENCES- direct2 ; transitive (2-hop) reaches target only via direct1
    const adapter = makeAdapter([
      [symbolRow("target")], // 1. exact match
      [symbolRow("direct1"), symbolRow("direct2"), symbolRow("transitive")], // 2. dependents (transitive closure)
      [], // 3. processes
      [], // 4. clusters
      [ // 5. direct callers (1-hop)
        { callerId: "direct1", edgeType: "tpc_CALLS" },
        { callerId: "direct2", edgeType: "tpc_REFERENCES" },
      ],
      [ // 6. degrees
        { id: "direct1", inDegree: 1, outDegree: 1 },
        { id: "direct2", inDegree: 0, outDegree: 3 },
        { id: "transitive", inDegree: 2, outDegree: 0 },
      ],
    ]);

    const result = await executeImpactAnalysis("target", 100, adapter);
    const ex = result.explanations ?? [];

    const byId = new Map(ex.map((e) => [e.symbolId, e]));

    expect(byId.get("direct1")?.hopDistance).toBe(1);
    expect(byId.get("direct1")?.entryEdge).toBe("calls");
    expect(byId.get("direct1")?.nodeRole).toBe("CoreLogic");

    expect(byId.get("direct2")?.hopDistance).toBe(1);
    expect(byId.get("direct2")?.entryEdge).toBe("references");
    expect(byId.get("direct2")?.nodeRole).toBe("EntryPoint"); // in 0, out > 0

    // Not a direct caller → hop 2, default calls edge, utility (in>0,out0)
    expect(byId.get("transitive")?.hopDistance).toBe(2);
    expect(byId.get("transitive")?.entryEdge).toBe("calls");
    expect(byId.get("transitive")?.nodeRole).toBe("Utility");

    // Direct callers should be more confident than the transitive one.
    expect(byId.get("direct1")!.confidence).toBeGreaterThan(byId.get("transitive")!.confidence);
  });

  it("produces one explanation per returned dependent (target excluded)", async () => {
    const adapter = makeAdapter([
      [symbolRow("target")],
      [symbolRow("a"), symbolRow("b")],
      [],
      [],
      [{ callerId: "a", edgeType: "CALLS" }],
      [{ id: "a", inDegree: 1, outDegree: 0 }, { id: "b", inDegree: 0, outDegree: 0 }],
    ]);

    const result = await executeImpactAnalysis("target", 100, adapter);

    // symbols = [target, a, b]; explanations only for a + b
    expect(result.symbols.map((s) => s.id)).toEqual(["target", "a", "b"]);
    expect((result.explanations ?? []).map((e) => e.symbolId).sort()).toEqual(["a", "b"]);
  });

  // ── Wave 8 (T1): degree.isExported reads the REAL persisted field ─────────
  it("derives degree.isExported from the persisted isExported field (private visibility, exported=true)", async () => {
    // The dependent is visibility:"private" (the old `visibility === "public"`
    // proxy would mark it NOT exported) but carries the persisted Wave 2 export
    // flag isExported:"true" — so the explanation must treat it as exported.
    const adapter = makeAdapter([
      [symbolRow("target")],
      [symbolRow("dep", { visibility: "private", isExported: "true" })],
      [],
      [],
      [{ callerId: "dep", edgeType: "CALLS" }],
      [{ id: "dep", inDegree: 2, outDegree: 2 }], // CoreLogic (well-connected)
    ]);

    const result = await executeImpactAnalysis("target", 100, adapter);
    const dep = (result.explanations ?? []).find((e) => e.symbolId === "dep");
    expect(dep?.nodeRole).toBe("CoreLogic");
    // The exported reason is only added when degree.isExported is true — proving
    // the persisted field (not visibility) drove it.
    expect(dep?.reasons.join(" ")).toMatch(/exported/i);
  });

  it("treats a persisted isExported=false dependent as NOT exported (overrides public visibility)", async () => {
    // visibility:"public" (proxy would say exported) but the persisted flag is
    // false → the exported reason must NOT appear.
    const adapter = makeAdapter([
      [symbolRow("target")],
      [symbolRow("dep", { visibility: "public", isExported: "false" })],
      [],
      [],
      [{ callerId: "dep", edgeType: "CALLS" }],
      [{ id: "dep", inDegree: 2, outDegree: 2 }],
    ]);

    const result = await executeImpactAnalysis("target", 100, adapter);
    const dep = (result.explanations ?? []).find((e) => e.symbolId === "dep");
    expect(dep?.reasons.join(" ")).not.toMatch(/exported/i);
  });

  it("returns no explanations when there are no dependents", async () => {
    const adapter = makeAdapter([
      [symbolRow("lonely")],
      [], // no dependents
      [],
      [],
      [], // direct callers
      [], // degrees
    ]);

    const result = await executeImpactAnalysis("lonely", 100, adapter);
    expect(result.explanations).toEqual([]);
  });
});
