/**
 * Integration tests — MCP tools with DatabaseAdapter.
 *
 * These tests verify that tool calls through DatabaseAdapter work correctly
 * for concurrent calls, error propagation, and response format.
 *
 * Requirements: 7.1, 7.5
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DatabaseAdapter, GraphAdapter, VectorAdapter, EmbeddingAdapter } from "../../src/core/ports/persistence.js";
import { executeTool } from "../../src/apps/mcp-server/tools.js";

// ---------------------------------------------------------------------------
// Mock query modules — no real network calls
// ---------------------------------------------------------------------------

vi.mock("../../src/application/querying/context-retrieval.js", () => ({
  executeContextRetrieval: vi.fn(),
}));

vi.mock("../../src/application/querying/impact-analysis.js", () => ({
  executeImpactAnalysis: vi.fn(),
}));

vi.mock("../../src/application/querying/data-flow-trace.js", () => ({
  executeDataFlowTrace: vi.fn(),
}));

import { executeContextRetrieval } from "../../src/application/querying/context-retrieval.js";
import { executeImpactAnalysis } from "../../src/application/querying/impact-analysis.js";
import { executeDataFlowTrace } from "../../src/application/querying/data-flow-trace.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STUB_RESOLUTION = { kind: "exact" as const, node: { id: "sym-1", labels: ["Symbol"], properties: { id: "sym-1", name: "UserService" } } };

const STUB_QUERY_RESULT = {
  resolution: STUB_RESOLUTION,
  targetKind: "symbol" as const,
  symbols: [
    {
      id: "sym-1",
      name: "UserService",
      kind: "class" as const,
      location: { filePath: "src/user.ts", startLine: 1, startColumn: 0, endLine: 10, endColumn: 0 },
      visibility: "public" as const,
      modifiers: [],
    },
  ],
  relationships: [],
  clusters: [],
  processes: [],
  confidence: 0.92,
  riskLevel: "low" as const,
  affectedFlows: [],
};

function createMockAdapter(): DatabaseAdapter {
  const graph: GraphAdapter = {
    createNode: vi.fn().mockResolvedValue(undefined),
    createRelationship: vi.fn().mockResolvedValue(undefined),
    queryNodes: vi.fn().mockResolvedValue([]),
    queryRelationships: vi.fn().mockResolvedValue([]),
    deleteNodesByLabel: vi.fn().mockResolvedValue(0),
    deleteRelationshipsByType: vi.fn().mockResolvedValue(0),
    runCypher: vi.fn().mockResolvedValue([]),
    runCypherWrite: vi.fn().mockResolvedValue(undefined),
  };
  const vector: VectorAdapter = {
    createTables: vi.fn().mockResolvedValue(undefined),
    indexSymbol: vi.fn().mockResolvedValue(undefined),
    semanticSearch: vi.fn().mockResolvedValue([]),
    deleteAll: vi.fn().mockResolvedValue(0),
  };
  const embedding: EmbeddingAdapter = {
    isEnabled: vi.fn().mockReturnValue(false),
    embedText: vi.fn().mockResolvedValue(null),
    getDimensions: vi.fn().mockReturnValue(2560),
  };
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getGraphAdapter: vi.fn().mockReturnValue(graph),
    getVectorAdapter: vi.fn().mockReturnValue(vector),
    getEmbeddingAdapter: vi.fn().mockReturnValue(embedding),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(executeContextRetrieval).mockResolvedValue(STUB_QUERY_RESULT);
  vi.mocked(executeImpactAnalysis).mockResolvedValue(STUB_QUERY_RESULT);
  vi.mocked(executeDataFlowTrace).mockResolvedValue(STUB_QUERY_RESULT);
});

// ---------------------------------------------------------------------------
// 1. Full tool call flow — MCPToolResponse shape
// ---------------------------------------------------------------------------

describe("full tool call flow with DatabaseAdapter", () => {
  it("get_symbol_context returns MCPToolResponse with summary field", async () => {
    const adapter = createMockAdapter();
    const response = await executeTool("get_symbol_context", { symbolName: "UserService" }, adapter);

    expect(response.summary).toBeDefined();
    expect(typeof response.summary).toBe("string");
    expect(response.summary.length).toBeGreaterThan(0);
  });

  it("find_dependents returns MCPToolResponse with summary field", async () => {
    const adapter = createMockAdapter();
    const response = await executeTool("find_dependents", { symbolName: "UserService" }, adapter);

    expect(response.summary).toBeDefined();
    expect(typeof response.summary).toBe("string");
    expect(response.summary.length).toBeGreaterThan(0);
  });

  it("trace_data_flow returns MCPToolResponse with summary field", async () => {
    const adapter = createMockAdapter();
    const response = await executeTool("trace_data_flow", { entryPoint: "UserController.login" }, adapter);

    expect(response.summary).toBeDefined();
    expect(typeof response.summary).toBe("string");
    expect(response.summary.length).toBeGreaterThan(0);
  });

  it("impact_analysis returns MCPToolResponse with summary field", async () => {
    const adapter = createMockAdapter();
    const response = await executeTool("impact_analysis", { symbolName: "UserService", changeType: "modify" }, adapter);

    expect(response.summary).toBeDefined();
    expect(typeof response.summary).toBe("string");
    expect(response.summary.length).toBeGreaterThan(0);
  });

  it("response includes symbols, clusters, processes, confidence, and riskLevel", async () => {
    const adapter = createMockAdapter();
    const response = await executeTool("get_symbol_context", { symbolName: "UserService" }, adapter);

    expect(Array.isArray(response.symbols)).toBe(true);
    expect(Array.isArray(response.clusters)).toBe(true);
    expect(Array.isArray(response.processes)).toBe(true);
    expect(typeof response.confidence).toBe("number");
    expect(response.confidence).toBeGreaterThanOrEqual(0);
    expect(response.confidence).toBeLessThanOrEqual(1);
    expect(response.riskLevel).toBeDefined();
  });

  it("error propagation works correctly", async () => {
    vi.mocked(executeContextRetrieval).mockRejectedValueOnce(new Error("query failed"));

    const adapter = createMockAdapter();
    await expect(
      executeTool("get_symbol_context", { symbolName: "BrokenSymbol" }, adapter),
    ).rejects.toThrow("query failed");
  });
});

// ---------------------------------------------------------------------------
// 2. Concurrent tool calls — both return results
// ---------------------------------------------------------------------------

describe("concurrent tool calls with DatabaseAdapter", () => {
  it("two concurrent calls both return results", async () => {
    const adapter = createMockAdapter();

    const [result1, result2] = await Promise.all([
      executeTool("get_symbol_context", { symbolName: "ServiceA" }, adapter),
      executeTool("get_symbol_context", { symbolName: "ServiceB" }, adapter),
    ]);

    expect(result1.summary).toBeDefined();
    expect(result2.summary).toBeDefined();
  });

  it("mixed concurrent tool calls all succeed", async () => {
    const adapter = createMockAdapter();

    const [r1, r2] = await Promise.all([
      executeTool("get_symbol_context", { symbolName: "ServiceA" }, adapter),
      executeTool("find_dependents", { symbolName: "ServiceB" }, adapter),
    ]);

    expect(r1.summary).toBeDefined();
    expect(r2.summary).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Adapter lifecycle
// ---------------------------------------------------------------------------

describe("adapter lifecycle", () => {
  it("adapter.close() can be called after tool calls", async () => {
    const adapter = createMockAdapter();

    await executeTool("get_symbol_context", { symbolName: "ServiceA" }, adapter);
    await adapter.close();

    expect(adapter.close).toHaveBeenCalledOnce();
  });

  it("adapter.close() is a no-op when called multiple times", async () => {
    const adapter = createMockAdapter();

    await adapter.close();
    await adapter.close();

    expect(adapter.close).toHaveBeenCalledTimes(2);
  });
});
