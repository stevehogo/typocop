/**
 * Unit tests for MCP tools with DatabaseAdapter.
 * Tests executeTool routing and adapter method calls.
 * Requirements: 7.5
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DatabaseAdapter, GraphAdapter, VectorAdapter, EmbeddingAdapter } from "../../core/ports/persistence.js";
import { executeTool } from "./tools.js";

// ── Mock adapter factory ──────────────────────────────────────────────────────

function createMockGraphAdapter(): GraphAdapter {
  return {
    createNode: vi.fn().mockResolvedValue(undefined),
    createRelationship: vi.fn().mockResolvedValue(undefined),
    queryNodes: vi.fn().mockResolvedValue([]),
    queryRelationships: vi.fn().mockResolvedValue([]),
    deleteNodesByLabel: vi.fn().mockResolvedValue(0),
    deleteRelationshipsByType: vi.fn().mockResolvedValue(0),
    runCypher: vi.fn().mockResolvedValue([]),
    runCypherWrite: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockVectorAdapter(): VectorAdapter {
  return {
    createTables: vi.fn().mockResolvedValue(undefined),
    indexSymbol: vi.fn().mockResolvedValue(undefined),
    semanticSearch: vi.fn().mockResolvedValue([]),
    deleteAll: vi.fn().mockResolvedValue(0),
  };
}

function createMockEmbeddingAdapter(): EmbeddingAdapter {
  return {
    isEnabled: vi.fn().mockReturnValue(false),
    embedText: vi.fn().mockResolvedValue(null),
    getDimensions: vi.fn().mockReturnValue(2560),
  };
}

function createMockAdapter(): DatabaseAdapter & {
  _graph: GraphAdapter;
  _vector: VectorAdapter;
  _embedding: EmbeddingAdapter;
} {
  const graph = createMockGraphAdapter();
  const vector = createMockVectorAdapter();
  const embedding = createMockEmbeddingAdapter();
  return {
    _graph: graph,
    _vector: vector,
    _embedding: embedding,
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getGraphAdapter: vi.fn().mockReturnValue(graph),
    getVectorAdapter: vi.fn().mockReturnValue(vector),
    getEmbeddingAdapter: vi.fn().mockReturnValue(embedding),
  };
}

describe("executeTool", () => {
  let adapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    adapter = createMockAdapter();
  });

  describe("routing", () => {
    it("routes get_symbol_context to context retrieval", async () => {
      const result = await executeTool("get_symbol_context", { symbolName: "foo" }, adapter);

      expect(adapter.getGraphAdapter).toHaveBeenCalled();
      expect(result).toHaveProperty("summary");
      expect(result.summary).toContain("foo");
      expect(result).toHaveProperty("symbols");
      expect(result).toHaveProperty("confidence");
    });

    it("routes find_dependents to impact analysis", async () => {
      const result = await executeTool("find_dependents", { symbolName: "bar" }, adapter);

      expect(adapter.getGraphAdapter).toHaveBeenCalled();
      expect(result).toHaveProperty("summary");
      expect(result.summary).toContain("bar");
    });

    it("routes trace_data_flow to data flow trace", async () => {
      const result = await executeTool("trace_data_flow", { entryPoint: "apiHandler" }, adapter);

      expect(adapter.getGraphAdapter).toHaveBeenCalled();
      expect(result).toHaveProperty("summary");
      expect(result.summary).toContain("apiHandler");
    });

    it("routes impact_analysis to impact analysis tool", async () => {
      const result = await executeTool("impact_analysis", { symbolName: "baz", changeType: "delete" }, adapter);

      expect(adapter.getGraphAdapter).toHaveBeenCalled();
      expect(result).toHaveProperty("summary");
      expect(result.summary).toContain("baz");
    });

    it("uses external package summary for dependency impact analysis", async () => {
      vi.mocked(adapter._graph.runCypher)
        .mockResolvedValueOnce([] as never)
        .mockResolvedValueOnce([{
          ext: {
            labels: ["ExternalDependency"],
            properties: { id: "ext:lodash", name: "lodash", aliases: "lodash,Lodash", ecosystem: "npm" },
          },
        }] as never)
        .mockResolvedValueOnce([{
          n: {
            labels: ["Symbol"],
            properties: {
              id: "sym-1",
              name: "useLodash",
              kind: "function",
              filePath: "/repo/src/use-lodash.ts",
              startLine: "1",
              startColumn: "0",
              endLine: "5",
              endColumn: "0",
              visibility: "public",
            },
          },
        }] as never)
        .mockResolvedValueOnce([] as never);

      const result = await executeTool("impact_analysis", { symbolName: "lodash", changeType: "modify" }, adapter);

      expect(result.summary).toContain("External package 'lodash'");
    });

    it("routes smart_search to smart search tool", async () => {
      const result = await executeTool("smart_search", { query: "auth flow" }, adapter);

      expect(adapter.getEmbeddingAdapter).toHaveBeenCalled();
      expect(result).toHaveProperty("summary");
      expect(result).toHaveProperty("symbols");
    });

    it("throws for unknown tool name", async () => {
      await expect(executeTool("nonexistent_tool", {}, adapter)).rejects.toThrow("Unknown tool: nonexistent_tool");
    });
  });

  describe("adapter method calls", () => {
    it("calls graphAdapter.runCypher for get_symbol_context", async () => {
      await executeTool("get_symbol_context", { symbolName: "test" }, adapter);

      expect(adapter._graph.runCypher).toHaveBeenCalled();
    });

    it("calls graphAdapter.runCypher for find_dependents", async () => {
      await executeTool("find_dependents", { symbolName: "test" }, adapter);

      expect(adapter._graph.runCypher).toHaveBeenCalled();
    });

    it("calls graphAdapter.runCypher for trace_data_flow", async () => {
      await executeTool("trace_data_flow", { entryPoint: "test" }, adapter);

      expect(adapter._graph.runCypher).toHaveBeenCalled();
    });

    it("calls graphAdapter.runCypher for impact_analysis", async () => {
      await executeTool("impact_analysis", { symbolName: "test" }, adapter);

      expect(adapter._graph.runCypher).toHaveBeenCalled();
    });

    it("checks embeddingAdapter.isEnabled for smart_search", async () => {
      await executeTool("smart_search", { query: "test" }, adapter);

      expect(adapter._embedding.isEnabled).toHaveBeenCalled();
    });
  });

  describe("response format", () => {
    it("returns MCPToolResponse with all required fields", async () => {
      const result = await executeTool("get_symbol_context", { symbolName: "test" }, adapter);

      expect(result.symbols).toBeInstanceOf(Array);
      expect(result.clusters).toBeInstanceOf(Array);
      expect(result.processes).toBeInstanceOf(Array);
      expect(typeof result.confidence).toBe("number");
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(["low", "medium", "high", "critical"]).toContain(result.riskLevel);
      expect(result.affectedFlows).toBeInstanceOf(Array);
      expect(typeof result.summary).toBe("string");
      expect(result.summary.length).toBeGreaterThan(0);
    });

    it("returns empty symbols when no graph data exists", async () => {
      const result = await executeTool("find_dependents", { symbolName: "nonexistent" }, adapter);

      expect(result.symbols).toEqual([]);
    });

    it("returns confidence 0.5 for smart_search with disabled embeddings", async () => {
      const result = await executeTool("smart_search", { query: "test" }, adapter);

      expect(result.confidence).toBe(0.5);
      expect(result.symbols).toEqual([]);
    });
  });

  describe("error handling", () => {
    it("propagates errors from graph adapter", async () => {
      vi.mocked(adapter._graph.runCypher).mockRejectedValue(new Error("DB connection failed"));

      await expect(
        executeTool("get_symbol_context", { symbolName: "test" }, adapter),
      ).rejects.toThrow("DB connection failed");
    });

    it("throws for smart_search with empty query", async () => {
      await expect(
        executeTool("smart_search", { query: "" }, adapter),
      ).rejects.toThrow("query is required");
    });

    it("throws for smart_search with whitespace-only query", async () => {
      await expect(
        executeTool("smart_search", { query: "   " }, adapter),
      ).rejects.toThrow("query is required");
    });
  });

  // ── D4: token-budgeted context slicing wiring through get_symbol_context ─────
  describe("get_symbol_context token-budgeted slicing (D4)", () => {
    function node(id: string, startLine = 1, endLine = 1) {
      return {
        n: {
          labels: ["Symbol"],
          properties: {
            id,
            name: id,
            kind: "function",
            filePath: `/repo/${id}.ts`,
            startLine: String(startLine),
            startColumn: "0",
            endLine: String(endLine),
            endColumn: "0",
            visibility: "public",
          },
        },
      };
    }

    // Wire a query-aware mock: exact resolve → target; caller/callee traversals →
    // two callers + two callees; everything else (processes/clusters/ext) → [].
    function wireContext() {
      vi.mocked(adapter._graph.runCypher).mockImplementation(async (query: string) => {
        if (query.includes("WHERE n.id = $val OR n.name = $val")) return [node("target")] as never;
        // findDependents: (n)-[:CALLS*]->(t) RETURN DISTINCT n
        if (query.includes("(n:Symbol)-[e:CALLS") && query.includes("(t:Symbol)")) {
          return [node("caller1"), node("caller2")] as never;
        }
        // findDependencies: (s)-[:CALLS*]->(n) RETURN DISTINCT n
        if (query.includes("(s:Symbol)-[e:CALLS") && query.includes("(n:Symbol)")) {
          return [node("callee1"), node("callee2")] as never;
        }
        return [] as never;
      });
    }

    it("with no tokenBudget the default (unsliced) behaviour is unchanged", async () => {
      wireContext();
      const result = await executeTool("get_symbol_context", { symbolName: "target" }, adapter);
      // target + 2 callers + 2 callees
      expect(result.symbols).toHaveLength(5);
      expect(result.truncationReason).toBeUndefined();
      expect(result.estimatedTokens).toBeUndefined();
      expect(result.summary).toContain("related symbols");
    });

    it("a generous budget includes everything and reports complete", async () => {
      wireContext();
      const result = await executeTool(
        "get_symbol_context",
        { symbolName: "target", tokenBudget: 100000 },
        adapter,
      );
      expect(result.symbols).toHaveLength(5);
      expect(result.truncationReason).toBe("complete");
      expect(typeof result.estimatedTokens).toBe("number");
      expect(result.summary).toContain("Context slice");
    });

    it("budget 0 with a pin returns only the pinned symbol(s)", async () => {
      wireContext();
      const result = await executeTool(
        "get_symbol_context",
        { symbolName: "target", tokenBudget: 1, pin: ["caller2"] },
        adapter,
      );
      expect(result.symbols.map((s) => s.id)).toEqual(["caller2"]);
      expect(result.truncationReason).toBe("token_budget");
    });

    it("pinned symbol is always present even when far over budget", async () => {
      wireContext();
      const result = await executeTool(
        "get_symbol_context",
        { symbolName: "target", tokenBudget: 1, pin: ["target", "callee1"] },
        adapter,
      );
      const ids = result.symbols.map((s) => s.id);
      expect(ids).toContain("target");
      expect(ids).toContain("callee1");
    });

    it("deterministic ordering: target → callers → callees", async () => {
      wireContext();
      const result = await executeTool(
        "get_symbol_context",
        { symbolName: "target", tokenBudget: 0 },
        adapter,
      );
      expect(result.symbols.map((s) => s.id)).toEqual([
        "target",
        "caller1",
        "caller2",
        "callee1",
        "callee2",
      ]);
    });
  });
});
