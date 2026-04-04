/**
 * Integration tests for MCP server.
 * Tests the complete flow from request to response.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Pool } from "pg";
import type { Session } from "neo4j-driver";
import { handleMCPRequest } from "./handler.js";
import type { MCPContext } from "./handler.js";
import { createAuthConfig } from "./auth.js";
import { createMCPServer } from "./registration.js";

describe("MCP Server Integration", () => {
  let mockContext: MCPContext;

  beforeEach(() => {
    mockContext = {
      vectorPool: {} as Pool,
      graphSession: {
        run: async () => ({ records: [] }),
      } as unknown as Session,
      authConfig: createAuthConfig(["test-token"], false), // Disable auth for integration tests
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
        const response = result.result as any;
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
        const response = result.result as any;
        expect(response).toHaveProperty("summary");
        expect(response.summary).toContain("dependents");
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
        const response = result.result as any;
        expect(response).toHaveProperty("summary");
        expect(response.summary).toContain("data flow");
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
        const response = result.result as any;
        expect(response).toHaveProperty("summary");
        expect(response.summary).toContain("Impact analysis");
        expect(response).toHaveProperty("riskLevel");
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
        const response = result.result as any;
        
        // Verify all required MCPToolResponse fields
        expect(response.symbols).toBeInstanceOf(Array);
        expect(response.clusters).toBeInstanceOf(Array);
        expect(response.processes).toBeInstanceOf(Array);
        expect(typeof response.confidence).toBe("number");
        expect(response.confidence).toBeGreaterThanOrEqual(0);
        expect(response.confidence).toBeLessThanOrEqual(1);
        expect(["low", "medium", "high", "critical"]).toContain(response.riskLevel);
        expect(response.affectedFlows).toBeInstanceOf(Array);
        expect(typeof response.summary).toBe("string");
        expect(response.summary.length).toBeGreaterThan(0);
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
          const response = result.result as any;
          expect(response.summary).toBeDefined();
          expect(typeof response.summary).toBe("string");
          expect(response.summary.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("Connection State Management", () => {
    it("maintains connection state across requests", async () => {
      const sessionId = "persistent-session";

      // First request
      await handleMCPRequest(
        { method: "get_symbol_context", params: { symbolName: "test1" } },
        mockContext,
        sessionId,
      );

      expect(mockContext.connectionStates.has(sessionId)).toBe(true);
      const state1 = mockContext.connectionStates.get(sessionId);

      // Second request
      await handleMCPRequest(
        { method: "find_dependents", params: { symbolName: "test2" } },
        mockContext,
        sessionId,
      );

      const state2 = mockContext.connectionStates.get(sessionId);
      expect(state2).toBe(state1); // Same state object
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
