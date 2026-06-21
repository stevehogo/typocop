/**
 * D6 — `find_dead_code` MCP tool tests. Exercises the response shape, the
 * candidate filtering (exports + entry-point names excluded), the kind filter,
 * the candidate caveat in the summary, and routing through executeTool.
 */
import { describe, it, expect, vi } from "vitest";
import type { DatabaseAdapter, GraphAdapter } from "../../core/ports/persistence.js";
import { executeFindDeadCode } from "./dead-code-tool.js";
import { executeTool } from "./tools.js";
import type { SymbolKind, Visibility } from "../../core/domain.js";

interface FixtureNode { id: string; name: string; kind?: SymbolKind; visibility?: Visibility }

function makeGraph(uncalled: FixtureNode[]): GraphAdapter {
  function nodeRow(n: FixtureNode) {
    return {
      n: {
        labels: ["Symbol"],
        properties: {
          id: n.id, name: n.name, kind: n.kind ?? "function",
          filePath: `/repo/${n.id}.ts`,
          startLine: "1", startColumn: "0", endLine: "9", endColumn: "0",
          visibility: n.visibility ?? "private",
        },
      },
    };
  }
  const runCypher = async <T,>(query: string): Promise<T[]> => {
    if (query.includes("NOT (s)<-[:CALLS]-()")) {
      return uncalled.map(nodeRow) as unknown as T[];
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

describe("executeFindDeadCode", () => {
  it("flags an uncalled utility-named symbol and includes the caveat", async () => {
    const adapter = makeAdapter(makeGraph([
      { id: "u1", name: "formatLabel", kind: "function", visibility: "private" },
    ]));
    const res = await executeFindDeadCode({}, adapter);
    expect(res.symbols.map((s) => s.name)).toEqual(["formatLabel"]);
    expect(res.symbols[0]?.relationship).toBe("dead-code-candidate");
    expect(res.summary).toContain("1 dead-code candidate");
    expect(res.summary).toContain("verify before deletion");
    expect(res.riskLevel).toBe("low");
  });

  it("excludes exported and entry-point-named uncalled symbols", async () => {
    const adapter = makeAdapter(makeGraph([
      { id: "e1", name: "publicFn", kind: "function", visibility: "public" },
      { id: "m1", name: "main", kind: "function", visibility: "private" },
    ]));
    const res = await executeFindDeadCode({}, adapter);
    expect(res.symbols).toHaveLength(0);
    expect(res.summary).toContain("No dead-code candidates found");
  });

  it("honors the kind filter", async () => {
    const adapter = makeAdapter(makeGraph([
      { id: "f1", name: "scratchFn", kind: "function", visibility: "private" },
      { id: "v1", name: "scratchVar", kind: "variable", visibility: "private" },
    ]));
    const res = await executeFindDeadCode({ kind: "variable" }, adapter);
    expect(res.symbols.map((s) => s.name)).toEqual(["scratchVar"]);
    expect(res.summary).toContain("kind: variable");
  });

  it("routes through executeTool by name", async () => {
    const adapter = makeAdapter(makeGraph([
      { id: "u1", name: "deadHelper", kind: "function", visibility: "private" },
    ]));
    const res = await executeTool("find_dead_code", {}, adapter);
    expect(res.symbols.map((s) => s.name)).toEqual(["deadHelper"]);
  });
});
