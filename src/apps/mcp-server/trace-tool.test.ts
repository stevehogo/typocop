/**
 * D3 — `trace` MCP tool tests. Exercises executeTraceTool's response shape,
 * the additive `trace` field, and the summary text for found / no-path /
 * unresolved-endpoint cases, plus routing through executeTool.
 */
import { describe, it, expect, vi } from "vitest";
import type { DatabaseAdapter, GraphAdapter } from "../../core/ports/persistence.js";
import { executeTraceTool, buildTraceSummary } from "./trace-tool.js";
import { executeTool } from "./tools.js";
import type { TracePathResult } from "../../application/querying/trace-path.js";

interface FixtureNode { id: string; filePath?: string; startLine?: number }
interface FixtureEdge { from: string; to: string; type: string }

function makeGraph(nodes: FixtureNode[], edges: FixtureEdge[]): GraphAdapter {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  function nodeRow(n: FixtureNode) {
    return {
      n: {
        labels: ["Symbol"],
        properties: {
          id: n.id, name: n.id, kind: "function",
          filePath: n.filePath ?? `/repo/${n.id}.ts`,
          startLine: String(n.startLine ?? 1), startColumn: "0", endLine: "9", endColumn: "0",
          visibility: "public",
        },
      },
    };
  }
  const runCypher = async <T,>(query: string, params?: Record<string, unknown>): Promise<T[]> => {
    const val = params?.["val"] as string | undefined;
    if (query.includes("-[e:CALLS|CONTAINS]->")) {
      return edges
        .filter((e) => e.from === val && (e.type === "CALLS" || e.type === "CONTAINS"))
        .map((e) => ({ neighbourId: e.to, edgeType: e.type })) as unknown as T[];
    }
    if (query.includes("WHERE n.id = $val") && query.includes("LIMIT 1")) {
      const hit = (val ? byId.get(val) : undefined) ?? nodes.find((n) => n.id === val);
      return (hit ? [nodeRow(hit)] : []) as unknown as T[];
    }
    if (query.includes("n.name CONTAINS $val")) {
      return nodes.filter((n) => n.id.includes(val ?? "")).map(nodeRow) as unknown as T[];
    }
    if (query.includes("RETURN DISTINCT n.name AS name")) {
      return nodes.map((n) => ({ name: n.id })) as unknown as T[];
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
    initialize: vi.fn(),
    close: vi.fn(),
    getGraphAdapter: () => graph,
    getVectorAdapter: vi.fn(),
    getEmbeddingAdapter: vi.fn(),
  } as unknown as DatabaseAdapter;
}

describe("executeTraceTool", () => {
  it("returns a hop chain on the additive trace field for a found path", async () => {
    const graph = makeGraph(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [
        { from: "a", to: "b", type: "CALLS" },
        { from: "b", to: "c", type: "CONTAINS" },
      ],
    );
    const res = await executeTraceTool({ fromSymbol: "a", toSymbol: "c" }, makeAdapter(graph));

    expect(res.trace?.found).toBe(true);
    expect(res.trace?.length).toBe(2);
    expect(res.trace?.hops.map((h) => h.symbolId)).toEqual(["a", "b", "c"]);
    expect(res.trace?.hops[0].edgeToNext).toBe("calls");
    expect(res.trace?.hops[1].edgeToNext).toBe("contains");
    // symbols mirror the hops; affectedFlows carries the flat id list.
    expect(res.symbols.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(res.affectedFlows).toEqual(["a", "b", "c"]);
    expect(res.summary).toContain("Path found");
    expect(res.summary).toContain("2 hops");
  });

  it("reports a helpful no-path summary with found:false", async () => {
    const graph = makeGraph(
      [{ id: "a" }, { id: "b" }],
      [{ from: "a", to: "b", type: "IMPORTS" }],
    );
    const res = await executeTraceTool({ fromSymbol: "a", toSymbol: "b" }, makeAdapter(graph));
    expect(res.trace?.found).toBe(false);
    expect(res.trace?.hops).toEqual([]);
    expect(res.summary).toContain("No CALLS/CONTAINS path found");
  });

  it("reports an unresolved endpoint in the summary", async () => {
    const graph = makeGraph([{ id: "a" }], []);
    const res = await executeTraceTool({ fromSymbol: "a", toSymbol: "ghost" }, makeAdapter(graph));
    expect(res.trace?.found).toBe(false);
    expect(res.summary).toContain("No path traced");
    expect(res.summary).toContain("not found");
  });

  it("respects maxDepth: a path longer than maxDepth yields found:false", async () => {
    const graph = makeGraph(
      [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      [
        { from: "a", to: "b", type: "CALLS" },
        { from: "b", to: "c", type: "CALLS" },
        { from: "c", to: "d", type: "CALLS" },
      ],
    );
    const shallow = await executeTraceTool({ fromSymbol: "a", toSymbol: "d", maxDepth: 2 }, makeAdapter(graph));
    expect(shallow.trace?.found).toBe(false);
    const deep = await executeTraceTool({ fromSymbol: "a", toSymbol: "d", maxDepth: 3 }, makeAdapter(graph));
    expect(deep.trace?.found).toBe(true);
  });

  it("is reachable through executeTool routing", async () => {
    const graph = makeGraph([{ id: "a" }, { id: "b" }], [{ from: "a", to: "b", type: "CALLS" }]);
    const res = await executeTool("trace", { fromSymbol: "a", toSymbol: "b" }, makeAdapter(graph));
    expect(res.trace?.found).toBe(true);
    expect(res.trace?.length).toBe(1);
  });
});

describe("buildTraceSummary", () => {
  it("renders the hop chain with edge types", () => {
    const result: TracePathResult = {
      resolution: {
        from: { kind: "exact", node: { id: "a", labels: [], properties: {} } },
        to: { kind: "exact", node: { id: "c", labels: [], properties: {} } },
      },
      found: true,
      length: 2,
      hops: [
        { symbolId: "a", name: "a", filePath: "", startLine: 1, edgeToNext: "calls" },
        { symbolId: "b", name: "b", filePath: "", startLine: 1, edgeToNext: "contains" },
        { symbolId: "c", name: "c", filePath: "", startLine: 1 },
      ],
    };
    const s = buildTraceSummary("a", "c", result);
    expect(s).toContain("a -[calls]-> b -[contains]-> c");
  });
});
