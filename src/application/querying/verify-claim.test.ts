/**
 * Task 7 — verify_claim orchestrator: parse → dispatch by kind → grade →
 * assemble. Covers all 3 claim kinds plus the not-found, parse-error, and
 * timeout degradation paths. The orchestrator NEVER throws to the agent.
 */
import { describe, it, expect, vi } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { executeVerifyClaim } from "./verify-claim.js";

interface FixtureEdge {
  from: string;
  to: string;
  type: string;
}

function makeGraph(nodeIds: string[], edges: FixtureEdge[]): GraphAdapter {
  function nodeRow(id: string) {
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
          endLine: "9",
          endColumn: "0",
          visibility: "public",
        },
      },
    };
  }

  const runCypher = async <T,>(query: string, params?: Record<string, unknown>): Promise<T[]> => {
    const val = params?.["val"] as string | undefined;
    if (query.includes("-[e:CALLS|CONTAINS]->")) {
      const out = edges
        .filter((e) => e.from === val && (e.type === "CALLS" || e.type === "CONTAINS"))
        .map((e) => ({ neighbourId: e.to, edgeType: e.type }));
      return out as unknown as T[];
    }
    if (query.includes("-[:CALLS]->") && query.includes("callerName")) {
      const callers = edges
        .filter((e) => e.to === val && e.type === "CALLS")
        .map((e) => ({ callerId: e.from, callerName: e.from }));
      return callers as unknown as T[];
    }
    if (query.includes("a.id = $from") && query.includes("b.id = $to")) {
      const from = params?.["from"] as string;
      const to = params?.["to"] as string;
      const types = [...new Set(edges.filter((e) => e.from === from && e.to === to).map((e) => e.type))];
      return types.map((t) => ({ edgeType: t })) as unknown as T[];
    }
    if (query.includes("WHERE n.id = $val") && query.includes("LIMIT 1")) {
      return (val && nodeIds.includes(val) ? [nodeRow(val)] : []) as unknown as T[];
    }
    if (query.includes("n.name CONTAINS $val")) {
      return nodeIds.filter((id) => id.includes(val ?? "")).map(nodeRow) as unknown as T[];
    }
    if (query.includes("RETURN DISTINCT n.name AS name")) {
      return nodeIds.map((id) => ({ name: id })) as unknown as T[];
    }
    return [] as T[];
  };

  return {
    createNode: async () => {},
    createRelationship: async () => {},
    queryNodes: async () => [],
    queryRelationships: async () => [],
    deleteNodesByLabel: async () => 0,
    deleteRelationshipsByType: async () => 0,
    runCypher: runCypher as GraphAdapter["runCypher"],
    runCypherWrite: async () => {},
  };
}

describe("executeVerifyClaim", () => {
  it("dispatches a usage claim", async () => {
    const graph = makeGraph(["x", "caller"], [{ from: "caller", to: "x", type: "CALLS" }]);
    const r = await executeVerifyClaim({ kind: "usage", symbol: "x" }, graph);
    expect(r.claim?.kind).toBe("usage");
    expect(r.verdict.verdict).toBe("refuted"); // x IS called
    expect(r.verdict.trueAnswer).toBeDefined();
  });

  it("dispatches an edge claim", async () => {
    const graph = makeGraph(["a", "b"], [{ from: "a", to: "b", type: "CALLS" }]);
    const r = await executeVerifyClaim({ kind: "edge", from: "a", to: "b", relation: "calls" }, graph);
    expect(r.claim?.kind).toBe("edge");
    expect(r.verdict.verdict).toBe("confirmed");
    expect(r.verdict.confidence).toBeGreaterThan(0);
  });

  it("dispatches a reachability claim", async () => {
    const graph = makeGraph(
      ["a", "b", "c"],
      [
        { from: "a", to: "b", type: "CALLS" },
        { from: "b", to: "c", type: "CALLS" },
      ],
    );
    const r = await executeVerifyClaim(
      { kind: "reachability", from: "a", to: "c", polarity: "reachable" },
      graph,
    );
    expect(r.claim?.kind).toBe("reachability");
    expect(r.verdict.verdict).toBe("confirmed");
  });

  it("degrades to uncertain on a parse error (never throws)", async () => {
    const graph = makeGraph([], []);
    const r = await executeVerifyClaim({ kind: "bogus" }, graph);
    expect(r.claim).toBeNull();
    expect(r.verdict.verdict).toBe("uncertain");
    expect(r.verdict.reason).toMatch(/kind|bogus|invalid/i);
  });

  it("degrades to uncertain for a not-found symbol (with suggestions)", async () => {
    const graph = makeGraph(["realName"], []);
    const r = await executeVerifyClaim({ kind: "usage", symbol: "ghost" }, graph);
    expect(r.verdict.verdict).toBe("uncertain");
    expect(r.verdict.evidence).toContain("realName");
  });

  it("degrades to uncertain on an internal error (never throws)", async () => {
    const graph = makeGraph(["a"], []);
    vi.spyOn(graph, "runCypher").mockRejectedValue(new Error("boom"));
    const r = await executeVerifyClaim({ kind: "usage", symbol: "a" }, graph);
    expect(r.verdict.verdict).toBe("uncertain");
  });

  it("degrades to uncertain on a timeout (never throws)", async () => {
    const slow = makeGraph(["a"], []);
    vi.spyOn(slow, "runCypher").mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([]), 1000)),
    );
    const r = await executeVerifyClaim({ kind: "usage", symbol: "a" }, slow, 20);
    expect(r.verdict.verdict).toBe("uncertain");
    expect(r.verdict.reason).toMatch(/time|unable|could not/i);
  });
});
