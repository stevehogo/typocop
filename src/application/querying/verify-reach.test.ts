/**
 * Task 5 — reachability/independence verifier (reuses executeTracePath).
 *
 * Mock answers the trace-path query shapes (resolve, fuzzy, suggestions,
 * CALLS|CONTAINS neighbour expansion, node hydrate).
 */
import { describe, it, expect } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { verifyReachability } from "./verify-reach.js";

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

describe("verifyReachability", () => {
  it("confirms a direct reachable claim, with the hop path as evidence", async () => {
    const graph = makeGraph(["a", "b"], [{ from: "a", to: "b", type: "CALLS" }]);
    const r = await verifyReachability("a", "b", "reachable", graph);
    expect(r.verdict).toBe("confirmed");
    expect(r.basis).toBe("presence");
    expect(r.evidence.join(" ")).toMatch(/a/);
    expect(r.evidence.join(" ")).toMatch(/b/);
  });

  it("confirms a transitive reachable claim", async () => {
    const graph = makeGraph(
      ["a", "b", "c"],
      [
        { from: "a", to: "b", type: "CALLS" },
        { from: "b", to: "c", type: "CALLS" },
      ],
    );
    const r = await verifyReachability("a", "c", "reachable", graph);
    expect(r.verdict).toBe("confirmed");
  });

  it("refutes a reachable claim when there is no path", async () => {
    const graph = makeGraph(["a", "b"], []);
    const r = await verifyReachability("a", "b", "reachable", graph);
    expect(r.verdict).toBe("refuted");
    expect(r.basis).toBe("absence");
  });

  it("refutes an independence claim when a path exists, with the path as counterexample", async () => {
    const graph = makeGraph(
      ["a", "b", "c"],
      [
        { from: "a", to: "b", type: "CALLS" },
        { from: "b", to: "c", type: "CALLS" },
      ],
    );
    const r = await verifyReachability("a", "c", "independent", graph);
    expect(r.verdict).toBe("refuted");
    expect(r.counterexample).toBeDefined();
  });

  it("is UNCERTAIN for an independence claim when no path is found (absence ≠ proof)", async () => {
    const graph = makeGraph(["a", "b"], []);
    const r = await verifyReachability("a", "b", "independent", graph);
    expect(r.verdict).toBe("uncertain");
  });

  it("is uncertain (graceful) when an endpoint cannot be resolved", async () => {
    const graph = makeGraph(["a"], []);
    const r = await verifyReachability("a", "ghost", "reachable", graph);
    expect(r.verdict).toBe("uncertain");
  });
});
