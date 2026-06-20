/**
 * E2 — `find_hotspots` MCP tool tests. Exercises the response shape (each
 * symbol carries its three metrics), the threshold/paging passthrough, routing
 * through executeTool, and validation of numeric params.
 */
import { describe, it, expect, vi } from "vitest";
import type { DatabaseAdapter, GraphAdapter } from "../../core/ports/persistence.js";
import { executeFindHotspots } from "./hotspots-tool.js";
import { executeTool } from "./tools.js";
import { validateToolParams } from "./validation.js";

interface FixtureNode { id: string; name: string; cyclomatic: number }

function makeGraph(symbols: FixtureNode[]): GraphAdapter {
  const nodeRow = (n: FixtureNode) => ({
    n: {
      labels: ["Symbol"],
      properties: {
        id: n.id, name: n.name, kind: "function",
        filePath: `/repo/${n.id}.ts`,
        startLine: "1", startColumn: "0", endLine: "9", endColumn: "0",
        visibility: "public",
        cyclomatic: String(n.cyclomatic),
        cognitive: String(n.cyclomatic + 1),
        maxLoopDepth: "1",
      },
    },
  });
  const runCypher = async <T,>(query: string, params?: Record<string, unknown>): Promise<T[]> => {
    if (!query.includes("toInteger(s.cyclomatic) > $min")) return [] as T[];
    const min = (params?.min as number) ?? 0;
    return symbols
      .filter((s) => s.cyclomatic > min)
      .sort((a, b) => b.cyclomatic - a.cyclomatic)
      .map(nodeRow) as unknown as T[];
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

describe("executeFindHotspots", () => {
  it("returns the most complex symbols with their metrics, highest first", async () => {
    const adapter = makeAdapter(makeGraph([
      { id: "a", name: "simple", cyclomatic: 2 },
      { id: "b", name: "gnarly", cyclomatic: 30 },
      { id: "c", name: "busy", cyclomatic: 15 },
    ]));
    const res = await executeFindHotspots({}, adapter);
    expect(res.symbols.map((s) => s.name)).toEqual(["gnarly", "busy"]);
    expect(res.symbols[0]).toMatchObject({
      relationship: "complexity-hotspot",
      cyclomatic: 30,
      cognitive: 31,
      maxLoopDepth: 1,
    });
    expect(res.summary).toContain("gnarly");
  });

  it("reports an empty result above the threshold", async () => {
    const adapter = makeAdapter(makeGraph([{ id: "a", name: "simple", cyclomatic: 2 }]));
    const res = await executeFindHotspots({ minComplexity: 100 }, adapter);
    expect(res.symbols).toEqual([]);
    expect(res.summary).toContain("No complexity hotspots");
  });

  it("routes through executeTool", async () => {
    const adapter = makeAdapter(makeGraph([{ id: "b", name: "gnarly", cyclomatic: 30 }]));
    const res = await executeTool("find_hotspots", { minComplexity: 5 }, adapter);
    expect(res.symbols.map((s) => s.name)).toEqual(["gnarly"]);
  });

  it("validates numeric params", () => {
    expect(() => validateToolParams("find_hotspots", { minComplexity: "x" })).toThrow();
    expect(() => validateToolParams("find_hotspots", { maxResults: -1 })).toThrow();
    expect(() => validateToolParams("find_hotspots", { minComplexity: 10, maxResults: 5, offset: 2 })).not.toThrow();
    expect(() => validateToolParams("find_hotspots", {})).not.toThrow();
  });
});
