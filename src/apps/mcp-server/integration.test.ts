/**
 * Integration tests for MCP server with DatabaseAdapter.
 * Tests the complete flow from request to response.
 * Requirements: 7.5
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DatabaseAdapter, GraphAdapter, VectorAdapter, EmbeddingAdapter } from "../../core/ports/persistence.js";
import { handleMCPRequest } from "./handler.js";
import type { MCPContext } from "./handler.js";
import { createAuthConfig } from "./auth.js";
import { createMCPServer } from "./registration.js";

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

function createMockDatabaseAdapter(): DatabaseAdapter {
  const graph = createMockGraphAdapter();
  const vector = createMockVectorAdapter();
  const embedding = createMockEmbeddingAdapter();
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getGraphAdapter: vi.fn().mockReturnValue(graph),
    getVectorAdapter: vi.fn().mockReturnValue(vector),
    getEmbeddingAdapter: vi.fn().mockReturnValue(embedding),
  };
}

describe("MCP Server Integration", () => {
  let mockContext: MCPContext;
  let mockAdapter: DatabaseAdapter;

  beforeEach(() => {
    mockAdapter = createMockDatabaseAdapter();
    mockContext = {
      adapter: mockAdapter,
      authConfig: createAuthConfig(["test-token"], false),
      connectionStates: new Map(),
    };
  });

  describe("Tool Registration", () => {
    it("creates MCP server with tools and prompts", () => {
      const server = createMCPServer();
      expect(server).toBeDefined();
    });
  });

  describe("Request Flow", () => {
    it("handles get_symbol_context request", async () => {
      const request = {
        method: "get_symbol_context",
        params: { symbolName: "testFunction" },
      };

      const result = await handleMCPRequest(request, mockContext, "session-1");

      expect(result).toHaveProperty("result");
      if ("result" in result) {
        const response = result.result as Record<string, unknown>;
        expect(response).toHaveProperty("summary");
        expect(response).toHaveProperty("symbols");
        expect(response).toHaveProperty("clusters");
        expect(response).toHaveProperty("processes");
        expect(response).toHaveProperty("confidence");
        expect(response).toHaveProperty("riskLevel");
        expect(response).toHaveProperty("affectedFlows");
      }
    });

    it("handles find_dependents request", async () => {
      const request = {
        method: "find_dependents",
        params: { symbolName: "testFunction", maxDepth: 3 },
      };

      const result = await handleMCPRequest(request, mockContext, "session-1");

      expect(result).toHaveProperty("result");
      if ("result" in result) {
        const response = result.result as Record<string, unknown>;
        expect(response).toHaveProperty("summary");
        expect(typeof response.summary).toBe("string");
        expect((response.summary as string).length).toBeGreaterThan(0);
      }
    });

    it("handles trace_data_flow request", async () => {
      const request = {
        method: "trace_data_flow",
        params: { entryPoint: "apiEndpoint" },
      };

      const result = await handleMCPRequest(request, mockContext, "session-1");

      expect(result).toHaveProperty("result");
      if ("result" in result) {
        const response = result.result as Record<string, unknown>;
        expect(response).toHaveProperty("summary");
        expect(typeof response.summary).toBe("string");
        expect((response.summary as string).length).toBeGreaterThan(0);
      }
    });

    it("handles impact_analysis request", async () => {
      const request = {
        method: "impact_analysis",
        params: { symbolName: "testFunction", changeType: "modify" },
      };

      const result = await handleMCPRequest(request, mockContext, "session-1");

      expect(result).toHaveProperty("result");
      if ("result" in result) {
        const response = result.result as Record<string, unknown>;
        expect(response).toHaveProperty("summary");
        expect(typeof response.summary).toBe("string");
        expect((response.summary as string).length).toBeGreaterThan(0);
        expect(response).toHaveProperty("riskLevel");
      }
    });

    it("handles smart_search request with embeddings disabled", async () => {
      const request = {
        method: "smart_search",
        params: { query: "authentication flow" },
      };

      const result = await handleMCPRequest(request, mockContext, "session-1");

      expect(result).toHaveProperty("result");
      if ("result" in result) {
        const response = result.result as Record<string, unknown>;
        expect(response).toHaveProperty("summary");
        expect(response).toHaveProperty("symbols");
        expect((response.symbols as unknown[])).toEqual([]);
        expect(response).toHaveProperty("confidence");
      }
    });
  });

  describe("MCPToolResponse Format", () => {
    it("returns response with all required fields", async () => {
      const request = {
        method: "get_symbol_context",
        params: { symbolName: "test" },
      };

      const result = await handleMCPRequest(request, mockContext, "session-1");

      if ("result" in result) {
        const response = result.result as Record<string, unknown>;

        expect(response.symbols).toBeInstanceOf(Array);
        expect(response.clusters).toBeInstanceOf(Array);
        expect(response.processes).toBeInstanceOf(Array);
        expect(typeof response.confidence).toBe("number");
        expect(response.confidence as number).toBeGreaterThanOrEqual(0);
        expect(response.confidence as number).toBeLessThanOrEqual(1);
        expect(["low", "medium", "high", "critical"]).toContain(response.riskLevel);
        expect(response.affectedFlows).toBeInstanceOf(Array);
        expect(typeof response.summary).toBe("string");
        expect((response.summary as string).length).toBeGreaterThan(0);
      }
    });

    it("includes human-readable summary in every response", async () => {
      const tools = ["get_symbol_context", "find_dependents", "trace_data_flow", "impact_analysis"];

      for (const tool of tools) {
        const request = {
          method: tool,
          params: tool === "trace_data_flow" ? { entryPoint: "test" } : { symbolName: "test" },
        };

        const result = await handleMCPRequest(request, mockContext, "session-1");

        if ("result" in result) {
          const response = result.result as Record<string, unknown>;
          expect(response.summary).toBeDefined();
          expect(typeof response.summary).toBe("string");
          expect((response.summary as string).length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("Connection State Management", () => {
    it("maintains connection state across requests", async () => {
      const sessionId = "persistent-session";

      await handleMCPRequest(
        { method: "get_symbol_context", params: { symbolName: "test1" } },
        mockContext,
        sessionId,
      );

      expect(mockContext.connectionStates.has(sessionId)).toBe(true);
      const state1 = mockContext.connectionStates.get(sessionId);

      await handleMCPRequest(
        { method: "find_dependents", params: { symbolName: "test2" } },
        mockContext,
        sessionId,
      );

      const state2 = mockContext.connectionStates.get(sessionId);
      expect(state2).toBe(state1);
    });

    it("creates separate states for different sessions", async () => {
      await handleMCPRequest(
        { method: "get_symbol_context", params: { symbolName: "test" } },
        mockContext,
        "session-1",
      );

      await handleMCPRequest(
        { method: "get_symbol_context", params: { symbolName: "test" } },
        mockContext,
        "session-2",
      );

      expect(mockContext.connectionStates.size).toBe(2);
      expect(mockContext.connectionStates.has("session-1")).toBe(true);
      expect(mockContext.connectionStates.has("session-2")).toBe(true);
    });
  });
});
