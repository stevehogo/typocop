/**
 * Preservation Property Tests — Task 2 (updated for DatabaseAdapter)
 *
 * Property 2: Preservation — Sequential Call Behavior Unchanged
 *
 * These tests verify that sequential tool calls through DatabaseAdapter
 * return valid MCPToolResponse objects and propagate errors correctly.
 *
 * Requirements: 3.1, 3.2, 7.1
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
import type { DatabaseAdapter, GraphAdapter, VectorAdapter, EmbeddingAdapter } from "../db/types.js";

// ---------------------------------------------------------------------------
// Mock query modules — return minimal valid results immediately
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
// Observation 1: single successful call (Req 3.1)
// ---------------------------------------------------------------------------

describe("Preservation — single successful call (Req 3.1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return a valid MCPToolResponse with summary for get_symbol_context", async () => {
    const adapter = createMockAdapter();
    const { executeTool } = await import("./tools.js");

    const result = await executeTool("get_symbol_context", { symbolName: "MySymbol" }, adapter);

    expect(result).toHaveProperty("summary");
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result).toHaveProperty("symbols");
    expect(result).toHaveProperty("clusters");
    expect(result).toHaveProperty("processes");
    expect(result).toHaveProperty("confidence");
    expect(result).toHaveProperty("riskLevel");
    expect(result).toHaveProperty("affectedFlows");
    expect(adapter.getGraphAdapter).toHaveBeenCalled();
  });

  it("should return a valid MCPToolResponse with summary for find_dependents", async () => {
    const adapter = createMockAdapter();
    const { executeTool } = await import("./tools.js");

    const result = await executeTool("find_dependents", { symbolName: "MySymbol" }, adapter);

    expect(result).toHaveProperty("summary");
    expect(typeof result.summary).toBe("string");
    expect(adapter.getGraphAdapter).toHaveBeenCalled();
  });

  it("should return a valid MCPToolResponse with summary for trace_data_flow", async () => {
    const adapter = createMockAdapter();
    const { executeTool } = await import("./tools.js");

    const result = await executeTool("trace_data_flow", { entryPoint: "MyController.handle" }, adapter);

    expect(result).toHaveProperty("summary");
    expect(typeof result.summary).toBe("string");
    expect(adapter.getGraphAdapter).toHaveBeenCalled();
  });

  it("should return a valid MCPToolResponse with summary for impact_analysis", async () => {
    const adapter = createMockAdapter();
    const { executeTool } = await import("./tools.js");

    const result = await executeTool("impact_analysis", { symbolName: "MySymbol", changeType: "modify" }, adapter);

    expect(result).toHaveProperty("summary");
    expect(typeof result.summary).toBe("string");
    expect(adapter.getGraphAdapter).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Observation 2: error propagation (Req 3.2)
// ---------------------------------------------------------------------------

describe("Preservation — error propagation (Req 3.2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should propagate error when query throws", async () => {
    const { executeContextRetrieval } = await import("../query/context-retrieval.js");
    vi.mocked(executeContextRetrieval).mockRejectedValueOnce(new Error("query failed"));

    const adapter = createMockAdapter();
    const { executeTool } = await import("./tools.js");

    await expect(
      executeTool("get_symbol_context", { symbolName: "BrokenSymbol" }, adapter),
    ).rejects.toThrow("query failed");
  });

  it("should propagate error for find_dependents", async () => {
    const { executeImpactAnalysis } = await import("../query/impact-analysis.js");
    vi.mocked(executeImpactAnalysis).mockRejectedValueOnce(new Error("Impact analysis failed"));

    const adapter = createMockAdapter();
    const { executeTool } = await import("./tools.js");

    await expect(
      executeTool("find_dependents", { symbolName: "BrokenSymbol" }, adapter),
    ).rejects.toThrow("Impact analysis failed");
  });

  it("should throw for unknown tool name", async () => {
    const adapter = createMockAdapter();
    const { executeTool } = await import("./tools.js");

    await expect(
      executeTool("unknown_tool", {}, adapter),
    ).rejects.toThrow("Unknown tool: unknown_tool");
  });
});

// ---------------------------------------------------------------------------
// Property-based test: sequential call sequences (Req 3.1, 3.2)
// ---------------------------------------------------------------------------

describe("Preservation — property: sequential call sequences behave correctly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return valid MCPToolResponse for any sequential tool call sequence", async () => {
    const { executeTool } = await import("./tools.js");

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.constantFrom(
            "get_symbol_context",
            "find_dependents",
            "trace_data_flow",
            "impact_analysis",
          ),
          { minLength: 1, maxLength: 5 },
        ),
        async (toolNames) => {
          vi.clearAllMocks();
          const adapter = createMockAdapter();

          for (const toolName of toolNames) {
            const params =
              toolName === "trace_data_flow"
                ? { entryPoint: "SomeEntry" }
                : { symbolName: "SomeSymbol" };

            const result = await executeTool(toolName, params, adapter);

            expect(result).toHaveProperty("summary");
            expect(typeof result.summary).toBe("string");
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it("should propagate errors for any failing tool call", async () => {
    const { executeTool } = await import("./tools.js");

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          "get_symbol_context",
          "find_dependents",
          "trace_data_flow",
          "impact_analysis",
        ),
        async (failingTool) => {
          vi.clearAllMocks();

          if (failingTool === "get_symbol_context") {
            const { executeContextRetrieval } = await import("../query/context-retrieval.js");
            vi.mocked(executeContextRetrieval).mockRejectedValueOnce(new Error("query error"));
          } else if (failingTool === "find_dependents" || failingTool === "impact_analysis") {
            const { executeImpactAnalysis } = await import("../query/impact-analysis.js");
            vi.mocked(executeImpactAnalysis).mockRejectedValueOnce(new Error("query error"));
          } else {
            const { executeDataFlowTrace } = await import("../query/data-flow-trace.js");
            vi.mocked(executeDataFlowTrace).mockRejectedValueOnce(new Error("query error"));
          }

          const adapter = createMockAdapter();
          const params =
            failingTool === "trace_data_flow"
              ? { entryPoint: "SomeEntry" }
              : { symbolName: "SomeSymbol" };

          await expect(
            executeTool(failingTool, params, adapter),
          ).rejects.toThrow("query error");
        },
      ),
      { numRuns: 20 },
    );
  });
});
