/**
 * D3 — the previously-dead `find_dependents.maxDepth` is now threaded into the
 * dependents traversal. These tests assert the CALLS variable-length bound in
 * the emitted Cypher reflects the (clamped) maxDepth.
 *
 * runCypher call order on the resolved-symbol path:
 *   1. exact-match lookup
 *   2. findDependents  (CALLS*1..<depth>)  <- the query under test
 *   3. findProcessesBySymbol
 *   4. findClustersBySymbol
 *   5. findDirectCallers
 *   6. fetchDegrees
 */
import { describe, it, expect, vi } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { executeImpactAnalysis, clampTraversalDepth } from "./impact-analysis.js";
import { MAX_TRAVERSAL_DEPTH } from "../../platform/utils/limits.js";

function symbolRow(id: string) {
  return {
    n: {
      labels: ["Symbol"],
      properties: {
        id, name: id, kind: "function", filePath: `/repo/${id}.ts`,
        startLine: "1", startColumn: "0", endLine: "5", endColumn: "0", visibility: "public",
      },
    },
  };
}

/** Captures every runCypher query string; returns canned responses positionally. */
function makeAdapter(responses: unknown[][]): { graph: GraphAdapter; queries: string[] } {
  const queries: string[] = [];
  let index = 0;
  const graph: GraphAdapter = {
    createNode: vi.fn(),
    createRelationship: vi.fn(),
    queryNodes: vi.fn(),
    queryRelationships: vi.fn(),
    deleteNodesByLabel: vi.fn(),
    deleteRelationshipsByType: vi.fn(),
    runCypher: vi.fn().mockImplementation((q: string) => {
      queries.push(q);
      return Promise.resolve(responses[index++] ?? []);
    }),
    runCypherWrite: vi.fn(),
  };
  return { graph, queries };
}

describe("clampTraversalDepth", () => {
  it("defaults/floors/caps", () => {
    expect(clampTraversalDepth(undefined)).toBe(MAX_TRAVERSAL_DEPTH);
    expect(clampTraversalDepth(0)).toBe(MAX_TRAVERSAL_DEPTH);
    expect(clampTraversalDepth(3)).toBe(3);
    expect(clampTraversalDepth(2.7)).toBe(2);
    expect(clampTraversalDepth(9999)).toBe(MAX_TRAVERSAL_DEPTH);
  });
});

describe("executeImpactAnalysis — maxDepth threading (D3)", () => {
  function responses() {
    return [
      [symbolRow("target")], // 1. exact
      [symbolRow("dep")],     // 2. dependents
      [],                     // 3. processes
      [],                     // 4. clusters
      [],                     // 5. direct callers
      [],                     // 6. degrees
    ];
  }

  it("uses MAX_TRAVERSAL_DEPTH in the CALLS bound when maxDepth is omitted", async () => {
    const { graph, queries } = makeAdapter(responses());
    await executeImpactAnalysis("target", 100, graph);
    const dependentsQuery = queries.find((q) => q.includes("CALLS*1.."));
    expect(dependentsQuery).toContain(`CALLS*1..${MAX_TRAVERSAL_DEPTH}`);
  });

  it("threads an explicit maxDepth into the CALLS bound", async () => {
    const { graph, queries } = makeAdapter(responses());
    await executeImpactAnalysis("target", 100, graph, 2);
    const dependentsQuery = queries.find((q) => q.includes("CALLS*1.."));
    expect(dependentsQuery).toContain("CALLS*1..2");
  });

  it("clamps an over-large maxDepth to MAX_TRAVERSAL_DEPTH", async () => {
    const { graph, queries } = makeAdapter(responses());
    await executeImpactAnalysis("target", 100, graph, 9999);
    const dependentsQuery = queries.find((q) => q.includes("CALLS*1.."));
    expect(dependentsQuery).toContain(`CALLS*1..${MAX_TRAVERSAL_DEPTH}`);
  });
});
