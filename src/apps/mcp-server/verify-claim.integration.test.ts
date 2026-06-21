/**
 * Task 9 — verify_claim integration against a realistic indexed-graph fixture.
 *
 * One in-memory graph models an indexed repo:
 *   handleRequest -CALLS-> service -CALLS-> repo        (a call chain)
 *   registry      -REFERENCES-> callback                 (registered, not called)
 *   deadUtil                                            (private, no callers)
 *
 * It exercises all three claim classes end-to-end through executeTool, INCLUDING
 * the mandatory `uncertain` case from a dynamic edge (a claimed CALLS where only
 * a REFERENCES edge exists — possible callback/DI dispatch).
 */
import { describe, it, expect } from "vitest";
import type { DatabaseAdapter, GraphAdapter } from "../../core/ports/persistence.js";
import { executeTool } from "./tools.js";
import { validateToolParams } from "./validation.js";

interface Edge {
  from: string;
  to: string;
  type: string;
}

const NODES = ["handleRequest", "service", "repo", "registry", "callback", "deadUtil"];
const PRIVATE = new Set(["service", "repo", "deadUtil"]);
const EDGES: Edge[] = [
  { from: "handleRequest", to: "service", type: "CALLS" },
  { from: "service", to: "repo", type: "CALLS" },
  { from: "registry", to: "callback", type: "REFERENCES" },
];

function makeGraph(): GraphAdapter {
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
          visibility: PRIVATE.has(id) ? "private" : "public",
        },
      },
    };
  }
  const runCypher = async <T,>(query: string, params?: Record<string, unknown>): Promise<T[]> => {
    const val = params?.["val"] as string | undefined;
    if (query.includes("-[e:CALLS|CONTAINS]->")) {
      return EDGES.filter((e) => e.from === val && (e.type === "CALLS" || e.type === "CONTAINS"))
        .map((e) => ({ neighbourId: e.to, edgeType: e.type })) as unknown as T[];
    }
    if (query.includes("-[:CALLS]->") && query.includes("callerName")) {
      return EDGES.filter((e) => e.to === val && e.type === "CALLS")
        .map((e) => ({ callerId: e.from, callerName: e.from })) as unknown as T[];
    }
    if (query.includes("a.id = $from") && query.includes("b.id = $to")) {
      const from = params?.["from"] as string;
      const to = params?.["to"] as string;
      const types = [...new Set(EDGES.filter((e) => e.from === from && e.to === to).map((e) => e.type))];
      return types.map((t) => ({ edgeType: t })) as unknown as T[];
    }
    if (query.includes("WHERE n.id = $val") && query.includes("LIMIT 1")) {
      return (val && NODES.includes(val) ? [nodeRow(val)] : []) as unknown as T[];
    }
    if (query.includes("n.name CONTAINS $val")) {
      return NODES.filter((id) => id.includes(val ?? "")).map(nodeRow) as unknown as T[];
    }
    if (query.includes("RETURN DISTINCT n.name AS name")) {
      return NODES.map((id) => ({ name: id })) as unknown as T[];
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

function makeAdapter(): DatabaseAdapter {
  const graph = makeGraph();
  return {
    initialize: async () => {},
    close: async () => {},
    getGraphAdapter: () => graph,
    getVectorAdapter: () => {
      throw new Error("not used");
    },
    getEmbeddingAdapter: () => {
      throw new Error("not used");
    },
  } as unknown as DatabaseAdapter;
}

/** Validate (as the handler does) then execute — full tool path. */
function verify(adapter: DatabaseAdapter, params: Record<string, unknown>) {
  validateToolParams("verify_claim", params);
  return executeTool("verify_claim", params, adapter);
}

describe("verify_claim integration (all 3 claim classes)", () => {
  it("usage: a private uncalled util is confirmed dead", async () => {
    const res = await verify(makeAdapter(), { kind: "usage", symbol: "deadUtil" });
    expect(res.verdict?.verdict).toBe("confirmed");
  });

  it("usage: a called service is refuted, with the true caller surfaced", async () => {
    const res = await verify(makeAdapter(), { kind: "usage", symbol: "service" });
    expect(res.verdict?.verdict).toBe("refuted");
    expect(res.verdict?.trueAnswer).toMatch(/handleRequest/);
  });

  it("edge: a real CALLS edge is confirmed", async () => {
    const res = await verify(makeAdapter(), {
      kind: "edge",
      from: "handleRequest",
      to: "service",
      relation: "calls",
    });
    expect(res.verdict?.verdict).toBe("confirmed");
  });

  it("edge (DYNAMIC → UNCERTAIN): a claimed CALLS with only a REFERENCES edge is uncertain, not refuted", async () => {
    const res = await verify(makeAdapter(), {
      kind: "edge",
      from: "registry",
      to: "callback",
      relation: "calls",
    });
    expect(res.verdict?.verdict).toBe("uncertain");
    expect(res.verdict?.reason).toMatch(/dynamic|callback|DI|reference/i);
  });

  it("reachability: a transitive path is confirmed", async () => {
    const res = await verify(makeAdapter(), {
      kind: "reachability",
      from: "handleRequest",
      to: "repo",
      polarity: "reachable",
    });
    expect(res.verdict?.verdict).toBe("confirmed");
  });

  it("reachability: independence of two unconnected symbols is uncertain (absence ≠ proof)", async () => {
    const res = await verify(makeAdapter(), {
      kind: "reachability",
      from: "deadUtil",
      to: "service",
      polarity: "independent",
    });
    expect(res.verdict?.verdict).toBe("uncertain");
  });

  it("never throws: a not-found symbol degrades to uncertain with suggestions", async () => {
    const res = await verify(makeAdapter(), { kind: "usage", symbol: "zzz_nope" });
    expect(res.verdict?.verdict).toBe("uncertain");
    expect(res.verdict?.evidence.length).toBeGreaterThan(0);
  });
});
