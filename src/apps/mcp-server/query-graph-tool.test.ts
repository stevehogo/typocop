/**
 * Wave 8 · T9 — `query_graph` MCP tool wrapper tests. Exercises the response
 * shape (the additive `queryGraph` block), pre-execution rejection of writes,
 * the row cap, prefix stripping, empty-result degradation, and routing through
 * executeTool by name. The querying-fn guardrails are tested exhaustively in
 * `application/querying/query-graph.test.ts`; here we assert the wrapper wires
 * them through and that a rejected query never reaches the adapter.
 */
import { describe, it, expect, vi } from "vitest";
import type { DatabaseAdapter, GraphAdapter } from "../../core/ports/persistence.js";
import { executeQueryGraph } from "./query-graph-tool.js";
import { executeTool } from "./tools.js";

function makeGraph(rows: Record<string, unknown>[] = []): {
  graph: GraphAdapter;
  runCypher: ReturnType<typeof vi.fn>;
  runCypherWrite: ReturnType<typeof vi.fn>;
} {
  const runCypher = vi.fn(async () => rows);
  const runCypherWrite = vi.fn(async () => {});
  const graph = {
    createNode: async () => {},
    createRelationship: async () => {},
    queryNodes: async () => [],
    queryRelationships: async () => [],
    deleteNodesByLabel: async () => 0,
    deleteRelationshipsByType: async () => 0,
    runCypher: runCypher as unknown as GraphAdapter["runCypher"],
    runCypherWrite: runCypherWrite as unknown as GraphAdapter["runCypherWrite"],
  } as GraphAdapter;
  return { graph, runCypher, runCypherWrite };
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

describe("executeQueryGraph", () => {
  it("happy path: returns rows in the additive queryGraph block", async () => {
    const adapter = makeAdapter(makeGraph([{ "s.name": "alpha" }]).graph);
    const res = await executeQueryGraph({ cypher: "MATCH (s:Symbol) RETURN s.name" }, adapter);
    expect(res.queryGraph?.ok).toBe(true);
    expect(res.queryGraph?.rowCount).toBe(1);
    expect(res.queryGraph?.rows).toEqual([{ "s.name": "alpha" }]);
    expect(res.symbols).toEqual([]);
    expect(res.riskLevel).toBe("low");
    expect(res.summary).toContain("1 row");
  });

  it("rejects a write query pre-execution and never calls the adapter", async () => {
    const { graph, runCypher, runCypherWrite } = makeGraph();
    const adapter = makeAdapter(graph);
    const res = await executeQueryGraph({ cypher: "CREATE (n:Symbol) RETURN n" }, adapter);
    expect(res.queryGraph?.ok).toBe(false);
    expect(res.queryGraph?.unsupported).toMatch(/^unsupported:/);
    expect(res.confidence).toBe(0);
    expect(res.summary).toContain("rejected");
    expect(runCypher).not.toHaveBeenCalled();
    expect(runCypherWrite).not.toHaveBeenCalled();
  });

  it("rejects a multi-statement query pre-execution", async () => {
    const { graph, runCypher } = makeGraph();
    const adapter = makeAdapter(graph);
    const res = await executeQueryGraph(
      { cypher: "MATCH (n) RETURN n; DROP TABLE x" },
      adapter,
    );
    expect(res.queryGraph?.ok).toBe(false);
    expect(res.queryGraph?.unsupported).toMatch(/multiple statements/i);
    expect(runCypher).not.toHaveBeenCalled();
  });

  it("caps rows and reports truncation in the summary", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ i }));
    const adapter = makeAdapter(makeGraph(rows).graph);
    const res = await executeQueryGraph({ cypher: "MATCH (s:Symbol) RETURN s", limit: 999 }, adapter);
    expect(res.queryGraph?.truncated).toBe(true);
    expect(res.queryGraph?.rowCount).toBe(200);
    expect(res.summary).toContain("truncated");
  });

  it("strips the persisted prefix from returned labels (default tpc_)", async () => {
    const adapter = makeAdapter(
      makeGraph([{ n: { labels: ["tpc_Symbol"], properties: { name: "foo" } } }]).graph,
    );
    const res = await executeQueryGraph({ cypher: "MATCH (n:Symbol) RETURN n" }, adapter);
    const row = res.queryGraph?.rows[0] as { n: { labels: string[] } };
    expect(row.n.labels).toEqual(["Symbol"]);
  });

  it("degrades gracefully to an empty result", async () => {
    const adapter = makeAdapter(makeGraph([]).graph);
    const res = await executeQueryGraph({ cypher: "MATCH (s:Symbol) RETURN s" }, adapter);
    expect(res.queryGraph?.ok).toBe(true);
    expect(res.queryGraph?.rowCount).toBe(0);
    expect(res.summary).toContain("no rows");
  });

  it("routes through executeTool by name", async () => {
    const adapter = makeAdapter(makeGraph([{ "s.name": "routed" }]).graph);
    const res = await executeTool("query_graph", { cypher: "MATCH (s:Symbol) RETURN s.name" }, adapter);
    expect(res.queryGraph?.rows).toEqual([{ "s.name": "routed" }]);
  });
});
