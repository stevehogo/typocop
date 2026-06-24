import { describe, it, expect, vi } from "vitest";
import type { DatabaseAdapter, GraphAdapter } from "../../core/ports/persistence.js";
import { executeExplain } from "./explain-tool.js";
import { executeTool } from "./tools.js";

function makeAdapter(findingRows: Record<string, string>[]): DatabaseAdapter {
  const graph: GraphAdapter = {
    createNode: async () => {}, createRelationship: async () => {},
    queryNodes: async () => [], queryRelationships: async () => [],
    deleteNodesByLabel: async () => 0, deleteRelationshipsByType: async () => 0,
    runCypher: (async <T,>() => findingRows.map((r) => ({ f: { id: r.id, labels: ["TaintFinding"], properties: r } })) as unknown as T[]) as GraphAdapter["runCypher"],
    runCypherWrite: async () => {},
  };
  return { initialize: vi.fn(), close: vi.fn(), getGraphAdapter: () => graph, getVectorAdapter: vi.fn(), getEmbeddingAdapter: vi.fn() } as unknown as DatabaseAdapter;
}

describe("executeExplain", () => {
  it("summarises findings and carries the never-auto-act caveat", async () => {
    const res = await executeExplain({}, makeAdapter([
      { id: "taint:1", sinkKind: "command", sourceId: "src/a.ts:handler:3:2", sinkId: "src/a.ts:handler:4:2", sourceLoc: "a.ts:3", sinkLoc: "a.ts:4", sanitized: "false", pathJson: "[]" },
    ]));
    expect(res.summary).toMatch(/never auto-act/i);
    expect(res.summary).toContain("a.ts:4");
  });
  it("routes through executeTool by name", async () => {
    const res = await executeTool("explain", { limit: 5 }, makeAdapter([]));
    expect(res.summary).toMatch(/no taint/i);
  });
});
