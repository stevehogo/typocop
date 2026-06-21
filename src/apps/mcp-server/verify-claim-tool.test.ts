/**
 * Task 8 — verify_claim MCP tool: dispatch, the additive `verdict` response
 * field + one-line summary, executeTool routing, and param validation.
 */
import { describe, it, expect } from "vitest";
import type { DatabaseAdapter, GraphAdapter } from "../../core/ports/persistence.js";
import { executeVerifyClaimTool } from "./verify-claim-tool.js";
import { executeTool } from "./tools.js";
import { validateToolParams } from "./validation.js";
import { MCPValidationError } from "./types.js";

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

function makeAdapter(graph: GraphAdapter): DatabaseAdapter {
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

describe("verify_claim tool", () => {
  it("refutes a dead-code claim and surfaces the true answer in the verdict + summary", async () => {
    const adapter = makeAdapter(makeGraph(["x", "caller"], [{ from: "caller", to: "x", type: "CALLS" }]));
    const res = await executeVerifyClaimTool({ kind: "usage", symbol: "x" }, adapter);
    expect(res.verdict?.claimKind).toBe("usage");
    expect(res.verdict?.verdict).toBe("refuted");
    expect(res.verdict?.trueAnswer).toBeDefined();
    expect(res.summary).toMatch(/REFUTED/);
    expect(res.confidence).toBeGreaterThan(0);
  });

  it("confirms an edge claim", async () => {
    const adapter = makeAdapter(makeGraph(["a", "b"], [{ from: "a", to: "b", type: "CALLS" }]));
    const res = await executeVerifyClaimTool(
      { kind: "edge", from: "a", to: "b", relation: "calls" },
      adapter,
    );
    expect(res.verdict?.verdict).toBe("confirmed");
    expect(res.summary).toMatch(/CONFIRMED/);
  });

  it("returns uncertain for an unprovable independence claim", async () => {
    const adapter = makeAdapter(makeGraph(["a", "b"], []));
    const res = await executeVerifyClaimTool(
      { kind: "reachability", from: "a", to: "b", polarity: "independent" },
      adapter,
    );
    expect(res.verdict?.verdict).toBe("uncertain");
  });

  it("routes through executeTool", async () => {
    const adapter = makeAdapter(makeGraph(["a", "b"], [{ from: "a", to: "b", type: "CALLS" }]));
    const res = await executeTool("verify_claim", { kind: "edge", from: "a", to: "b", relation: "calls" }, adapter);
    expect(res.verdict?.verdict).toBe("confirmed");
  });

  it("does not populate the verdict field for other tools (additive)", async () => {
    const adapter = makeAdapter(makeGraph([], []));
    const res = await executeTool("find_dead_code", {}, adapter);
    expect(res.verdict).toBeUndefined();
  });
});

describe("verify_claim validation", () => {
  it("accepts a valid usage claim", () => {
    expect(() => validateToolParams("verify_claim", { kind: "usage", symbol: "x" })).not.toThrow();
  });
  it("rejects a missing kind", () => {
    expect(() => validateToolParams("verify_claim", {})).toThrow(MCPValidationError);
  });
  it("rejects a usage claim without a symbol", () => {
    expect(() => validateToolParams("verify_claim", { kind: "usage" })).toThrow(MCPValidationError);
  });
  it("rejects an edge claim with a bad relation", () => {
    expect(() =>
      validateToolParams("verify_claim", { kind: "edge", from: "a", to: "b", relation: "contains" }),
    ).toThrow(MCPValidationError);
  });
  it("rejects a reachability claim without a polarity", () => {
    expect(() =>
      validateToolParams("verify_claim", { kind: "reachability", from: "a", to: "b" }),
    ).toThrow(MCPValidationError);
  });
});
