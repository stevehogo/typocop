/**
 * Tests for MCP request handler with DatabaseAdapter.
 * Requirements: 7.1
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DatabaseAdapter } from "../../core/ports/persistence.js";
import { handleMCPRequest, createConnectionState } from "./handler.js";
import type { MCPContext } from "./handler.js";
import { createAuthConfig } from "./auth.js";
import type { AuthConfig } from "./auth.js";

// Mock the tools module
vi.mock("./tools.js", () => ({
  executeTool: vi.fn().mockResolvedValue({
    symbols: [],
    clusters: [],
    processes: [],
    confidence: 0.9,
    riskLevel: "low",
    affectedFlows: [],
    summary: "Test summary",
  }),
}));

function createMockAdapter(): DatabaseAdapter {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getGraphAdapter: vi.fn().mockReturnValue({}),
    getVectorAdapter: vi.fn().mockReturnValue({}),
    getEmbeddingAdapter: vi.fn().mockReturnValue({}),
  };
}

describe("createConnectionState", () => {
  it("creates a new connection state with session ID", () => {
    const state = createConnectionState("test-session");

    expect(state.sessionId).toBe("test-session");
    expect(state.authenticated).toBe(false);
    expect(state.connectedAt).toBeInstanceOf(Date);
  });
});

describe("handleMCPRequest", () => {
  let mockContext: MCPContext;

  beforeEach(() => {
    mockContext = {
      adapter: createMockAdapter(),
      authConfig: createAuthConfig(["valid-token"], true),
      connectionStates: new Map(),
    };
  });

  it("returns validation error for malformed request", async () => {
    const result = await handleMCPRequest(null, mockContext, "session-1");

    expect(result).toHaveProperty("code", "INVALID_REQUEST_FORMAT");
    expect(result).toHaveProperty("message");
  });

  it("returns validation error for missing method", async () => {
    const result = await handleMCPRequest({ params: {} }, mockContext, "session-1");

    expect(result).toHaveProperty("code", "MISSING_METHOD");
  });

  it("returns validation error for invalid params", async () => {
    const result = await handleMCPRequest(
      { method: "test", params: "invalid" },
      mockContext,
      "session-1",
    );

    expect(result).toHaveProperty("code", "INVALID_PARAMS");
  });

  it("returns authentication error for missing token", async () => {
    const result = await handleMCPRequest(
      { method: "get_symbol_context", params: { symbolName: "test" } },
      mockContext,
      "session-1",
    );

    expect(result).toHaveProperty("code", "AUTHENTICATION_FAILED");
  });

  it("returns authentication error for invalid token", async () => {
    const result = await handleMCPRequest(
      { method: "get_symbol_context", params: { symbolName: "test", token: "invalid" } },
      mockContext,
      "session-1",
    );

    expect(result).toHaveProperty("code", "AUTHENTICATION_FAILED");
  });

  it("creates connection state on first request", async () => {
    await handleMCPRequest(
      { method: "get_symbol_context", params: { symbolName: "test", token: "valid-token" } },
      mockContext,
      "session-1",
    );

    expect(mockContext.connectionStates.has("session-1")).toBe(true);
    const state = mockContext.connectionStates.get("session-1");
    expect(state?.sessionId).toBe("session-1");
  });

  it("reuses connection state for subsequent requests", async () => {
    const firstState = createConnectionState("session-1");
    mockContext.connectionStates.set("session-1", firstState);

    await handleMCPRequest(
      { method: "get_symbol_context", params: { symbolName: "test", token: "valid-token" } },
      mockContext,
      "session-1",
    );

    const state = mockContext.connectionStates.get("session-1");
    expect(state).toBe(firstState);
  });

  it("accepts valid token from params", async () => {
    const result = await handleMCPRequest(
      { method: "get_symbol_context", params: { symbolName: "test", token: "valid-token" } },
      mockContext,
      "session-1",
    );

    expect(result).toHaveProperty("result");
    expect(result).toHaveProperty("metadata");
  });

  it("accepts valid token from Authorization header", async () => {
    const result = await handleMCPRequest(
      { method: "get_symbol_context", params: { symbolName: "test" } },
      mockContext,
      "session-1",
      { authorization: "Bearer valid-token" },
    );

    expect(result).toHaveProperty("result");
    expect(result).toHaveProperty("metadata");
  });

  it("bypasses authentication when disabled", async () => {
    (mockContext as { authConfig: AuthConfig }).authConfig = createAuthConfig([], false);

    const result = await handleMCPRequest(
      { method: "get_symbol_context", params: { symbolName: "test" } },
      mockContext,
      "session-1",
    );

    expect(result).toHaveProperty("result");
  });
});
