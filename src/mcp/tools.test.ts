/**
 * Unit tests for MCP tools with DatabaseAdapter.
 * Tests executeTool routing and adapter method calls.
 * Requirements: 7.5
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DatabaseAdapter, GraphAdapter, VectorAdapter, EmbeddingAdapter } from "../db/types.js";
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
});
