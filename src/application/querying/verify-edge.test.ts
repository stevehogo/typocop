/**
 * Task 4 — edge-existence verifier.
 *
 * Query-aware mock answering:
 *   - exact resolve:   MATCH (n:Symbol) WHERE n.id = $val OR n.name = $val ... LIMIT 1
 *   - suggestions:     MATCH (n:Symbol) RETURN DISTINCT n.name AS name LIMIT 1000
 *   - edges from→to:   MATCH (a:Symbol)-[e]->(b:Symbol) WHERE a.id = $from AND b.id = $to ...
 */
import { describe, it, expect } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { verifyEdge } from "./verify-edge.js";

interface FixtureEdge {
  from: string;
  to: string;
  type: string; // raw label, e.g. CALLS / REFERENCES
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
    if (query.includes("a.id = $from") && query.includes("b.id = $to")) {
      const from = params?.["from"] as string;
      const to = params?.["to"] as string;
      const types = [...new Set(edges.filter((e) => e.from === from && e.to === to).map((e) => e.type))];
      return types.map((t) => ({ edgeType: t })) as unknown as T[];
    }
    if (query.includes("WHERE n.id = $val") && query.includes("LIMIT 1")) {
      const val = params?.["val"] as string;
      return (nodeIds.includes(val) ? [nodeRow(val)] : []) as unknown as T[];
    }
    if (query.includes("n.name CONTAINS $val")) {
      const val = params?.["val"] as string;
      return nodeIds.filter((id) => id.includes(val)).map(nodeRow) as unknown as T[];
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

describe("verifyEdge", () => {
  it("confirms an existing CALLS edge", async () => {
    const graph = makeGraph(["A", "B"], [{ from: "A", to: "B", type: "CALLS" }]);
    const a = await verifyEdge("A", "B", "calls", graph);
    expect(a.verdict).toBe("confirmed");
    expect(a.basis).toBe("presence");
  });

  it("refutes an absent edge when no edges connect the endpoints", async () => {
    const graph = makeGraph(["A", "B"], []);
    const a = await verifyEdge("A", "B", "calls", graph);
    expect(a.verdict).toBe("refuted");
    expect(a.basis).toBe("absence");
    expect(a.dynamicReachable).toBe(false);
  });

  it("refutes an absent static edge (imports) even when other edges exist", async () => {
    const graph = makeGraph(["A", "B"], [{ from: "A", to: "B", type: "CALLS" }]);
    const a = await verifyEdge("A", "B", "imports", graph);
    expect(a.verdict).toBe("refuted");
    expect(a.evidence.join(" ")).toMatch(/calls/i);
  });

  it("is uncertain for an absent CALLS edge when a REFERENCES edge exists (possible dynamic/callback dispatch)", async () => {
    const graph = makeGraph(["A", "B"], [{ from: "A", to: "B", type: "REFERENCES" }]);
    const a = await verifyEdge("A", "B", "calls", graph);
    expect(a.verdict).toBe("uncertain");
    expect(a.dynamicReachable).toBe(true);
  });

  it("is uncertain (graceful) when an endpoint cannot be resolved", async () => {
    const graph = makeGraph(["A"], []);
    const a = await verifyEdge("A", "ghost", "calls", graph);
    expect(a.verdict).toBe("uncertain");
  });

  // ── Wave 8 (T2): MRO-derived heritage relations ───────────────────────────
  it("confirms an existing OVERRIDES edge for relation 'overrides'", async () => {
    const graph = makeGraph(["Sub.m", "Base.m"], [{ from: "Sub.m", to: "Base.m", type: "OVERRIDES" }]);
    const a = await verifyEdge("Sub.m", "Base.m", "overrides", graph);
    expect(a.verdict).toBe("confirmed");
    expect(a.basis).toBe("presence");
  });

  it("confirms an existing METHODIMPLEMENTS edge for relation 'methodImplements'", async () => {
    const graph = makeGraph(["Impl.m", "Iface.m"], [{ from: "Impl.m", to: "Iface.m", type: "METHODIMPLEMENTS" }]);
    const a = await verifyEdge("Impl.m", "Iface.m", "methodImplements", graph);
    expect(a.verdict).toBe("confirmed");
    expect(a.basis).toBe("presence");
  });

  it("refutes a claimed 'overrides' edge when only an INHERITS edge connects the endpoints", async () => {
    const graph = makeGraph(["Sub.m", "Base.m"], [{ from: "Sub.m", to: "Base.m", type: "INHERITS" }]);
    const a = await verifyEdge("Sub.m", "Base.m", "overrides", graph);
    expect(a.verdict).toBe("refuted");
    expect(a.basis).toBe("absence");
    expect(a.evidence.join(" ")).toMatch(/inherits/i);
  });
});
