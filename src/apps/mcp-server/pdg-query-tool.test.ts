import { describe, it, expect, vi } from "vitest";
import type { DatabaseAdapter, GraphAdapter } from "../../core/ports/persistence.js";
import { executePdgQuery } from "./pdg-query-tool.js";
import { executeTool } from "./tools.js";

function makeAdapter(rows: Record<string, string>[]): DatabaseAdapter {
  const graph: GraphAdapter = {
    createNode: async () => {}, createRelationship: async () => {},
    queryNodes: async () => [], queryRelationships: async () => [],
    deleteNodesByLabel: async () => 0, deleteRelationshipsByType: async () => 0,
    runCypher: (async <T,>() => rows as unknown as T[]) as GraphAdapter["runCypher"],
    runCypherWrite: async () => {},
  };
  return { initialize: vi.fn(), close: vi.fn(), getGraphAdapter: () => graph, getVectorAdapter: vi.fn(), getEmbeddingAdapter: vi.fn() } as unknown as DatabaseAdapter;
}

describe("executePdgQuery", () => {
  it("flows mode returns the findings + a summary", async () => {
    const res = await executePdgQuery({ mode: "flows", target: "handler" }, makeAdapter([{ id: "taint:1", sinkKind: "command" }]));
    expect(res.summary).toMatch(/taint flow/i);
    expect(res.riskLevel).toBe("low");
  });
  it("routes through executeTool by name", async () => {
    const res = await executeTool("pdg_query", { mode: "controls", target: "x" }, makeAdapter([]));
    expect(res.summary.length).toBeGreaterThan(0);
  });
});
