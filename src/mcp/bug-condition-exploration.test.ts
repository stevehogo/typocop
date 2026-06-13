/**
 * Bug Condition Exploration Test — Task 1 (updated for DatabaseAdapter)
 *
 * These tests verify that concurrent tool calls through DatabaseAdapter
 * work correctly. With the adapter pattern, session management is handled
 * internally by the adapter, eliminating the original session leak bug.
 *
 * Requirements: 1.1, 1.2, 7.1
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DatabaseAdapter, GraphAdapter, VectorAdapter, EmbeddingAdapter } from "../core/ports/persistence.js";

// ---------------------------------------------------------------------------
// Mock query modules
// ---------------------------------------------------------------------------

const STUB_RESOLUTION = { kind: "exact" as const, node: { id: "sym-1", labels: ["Symbol"], properties: { id: "sym-1", name: "TestSymbol" } } };

vi.mock("../query/context-retrieval.js", () => ({
  executeContextRetrieval: vi.fn().mockResolvedValue({
    resolution: STUB_RESOLUTION,
    symbols: [],
    relationships: [],
    clusters: [],
    processes: [],
    confidence: 0.9,
    riskLevel: "low",
    affectedFlows: [],
  }),
}));

vi.mock("../query/impact-analysis.js", () => ({
  executeImpactAnalysis: vi.fn().mockResolvedValue({
    resolution: STUB_RESOLUTION,
    targetKind: "symbol",
    symbols: [],
    relationships: [],
    clusters: [],
    processes: [],
    confidence: 0.9,
    riskLevel: "low",
    affectedFlows: [],
  }),
}));

vi.mock("../query/data-flow-trace.js", () => ({
  executeDataFlowTrace: vi.fn().mockResolvedValue({
    resolution: STUB_RESOLUTION,
    symbols: [],
    relationships: [],
    clusters: [],
    processes: [],
    confidence: 0.9,
    riskLevel: "low",
    affectedFlows: [],
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Tests
// ---------------------------------------------------------------------------

describe("Concurrent tool calls through DatabaseAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should handle concurrent calls without session conflicts", async () => {
    const adapter = createMockAdapter();
    const { executeTool } = await import("./tools.js");

    const [result1, result2] = await Promise.all([
      executeTool("get_symbol_context", { symbolName: "SymbolA" }, adapter),
      executeTool("get_symbol_context", { symbolName: "SymbolB" }, adapter),
    ]);

    expect(result1).toHaveProperty("summary");
    expect(result2).toHaveProperty("summary");
    expect(adapter.getGraphAdapter).toHaveBeenCalled();
  });

  it("should handle mixed concurrent tool calls", async () => {
    const adapter = createMockAdapter();
    const { executeTool } = await import("./tools.js");

    const [r1, r2, r3] = await Promise.all([
      executeTool("get_symbol_context", { symbolName: "A" }, adapter),
      executeTool("find_dependents", { symbolName: "B" }, adapter),
      executeTool("trace_data_flow", { entryPoint: "C" }, adapter),
    ]);

    expect(r1).toHaveProperty("summary");
    expect(r2).toHaveProperty("summary");
    expect(r3).toHaveProperty("summary");
  });

  it("should propagate errors from one call without affecting others", async () => {
    const { executeContextRetrieval } = await import("../query/context-retrieval.js");
    let callCount = 0;
    vi.mocked(executeContextRetrieval).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("first call failed");
      }
      return {
        resolution: STUB_RESOLUTION,
        symbols: [],
        relationships: [],
        clusters: [],
        processes: [],
        confidence: 0.9,
        riskLevel: "low" as const,
        affectedFlows: [],
      };
    });

    const adapter = createMockAdapter();
    const { executeTool } = await import("./tools.js");

    const results = await Promise.allSettled([
      executeTool("get_symbol_context", { symbolName: "A" }, adapter),
      executeTool("get_symbol_context", { symbolName: "B" }, adapter),
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("fulfilled");
  });
});
