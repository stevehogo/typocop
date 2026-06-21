/**
 * Integration tests — MCP tools with DatabaseAdapter.
 *
 * Covers:
 *   6.1 tools/list response includes smart_search (Req 1.8)
 *   6.2 smart_search with DatabaseAdapter (Req 7.3, 7.4)
 *   6.3 Existing four tools still return valid MCPToolResponse (Req 3.1, 7.1)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DatabaseAdapter, GraphAdapter, VectorAdapter, EmbeddingAdapter } from "../../src/core/ports/persistence.js";
import { createMCPServer } from "../../src/apps/mcp-server/registration.js";
import { executeTool } from "../../src/apps/mcp-server/tools.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// ---------------------------------------------------------------------------
// Mock query modules for non-regression tests (6.3)
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

const STUB_RESOLUTION = { kind: "exact" as const, node: { id: "sym-1", labels: ["Symbol"], properties: { id: "sym-1", name: "RateLimiter" } } };

const STUB_QUERY_RESULT = {
  resolution: STUB_RESOLUTION,
  targetKind: "symbol" as const,
  symbols: [
    {
      id: "sym-1",
      logicalKey: "sym-1",
      name: "RateLimiter",
      kind: "class" as const,
      location: { filePath: "src/rate-limiter.ts", startLine: 1, startColumn: 0, endLine: 20, endColumn: 0 },
      visibility: "public" as const,
      modifiers: [],
    },
  ],
  relationships: [],
  clusters: [],
  processes: [],
  confidence: 0.88,
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(executeContextRetrieval).mockResolvedValue(STUB_QUERY_RESULT);
  vi.mocked(executeImpactAnalysis).mockResolvedValue(STUB_QUERY_RESULT);
  vi.mocked(executeDataFlowTrace).mockResolvedValue(STUB_QUERY_RESULT);
});

// ---------------------------------------------------------------------------
// Helper: create a connected client/server pair via InMemoryTransport
// ---------------------------------------------------------------------------

async function createConnectedClient(): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = createMCPServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-client", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      await client.close();
    },
  };
}

// ---------------------------------------------------------------------------
// 6.1 — tools/list includes smart_search (Req 1.8)
// ---------------------------------------------------------------------------

describe("6.1 tools/list includes smart_search", () => {
  it("smart_search appears in the tools list alongside the four existing tools", async () => {
    const { client, cleanup } = await createConnectedClient();
    try {
      const response = await client.listTools();
      const toolNames = response.tools.map((t) => t.name);

      expect(toolNames).toContain("smart_search");
      expect(toolNames).toContain("get_symbol_context");
      expect(toolNames).toContain("trace_data_flow");
      expect(toolNames).toContain("impact_analysis");
      // find_dependents was merged into impact_analysis.
      expect(toolNames).not.toContain("find_dependents");
    } finally {
      await cleanup();
    }
  });

  it("smart_search tool definition has required query parameter", async () => {
    const { client, cleanup } = await createConnectedClient();
    try {
      const response = await client.listTools();
      const smartSearch = response.tools.find((t) => t.name === "smart_search");

      expect(smartSearch).toBeDefined();
      expect(smartSearch?.inputSchema.required).toContain("query");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 6.2 — smart_search with DatabaseAdapter (Req 7.3, 7.4)
// ---------------------------------------------------------------------------

describe("6.2 smart_search with DatabaseAdapter", () => {
  it("returns empty results with confidence 0.5 when embeddings are disabled", async () => {
    const adapter = createMockAdapter();

    const response = await executeTool("smart_search", { query: "ip rate limiting" }, adapter);

    expect(response.symbols).toEqual([]);
    expect(response.confidence).toBe(0.5);
    expect(typeof response.summary).toBe("string");
    expect(response.summary.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6.3 — Non-regression: existing tools return valid MCPToolResponse (Req 3.1, 7.1)
// ---------------------------------------------------------------------------

describe("6.3 existing tools return valid MCPToolResponse", () => {
  const EXISTING_TOOLS: Array<[string, Record<string, unknown>]> = [
    ["get_symbol_context", { symbolName: "RateLimiter" }],
    ["trace_data_flow", { entryPoint: "RateLimiterController.check" }],
    ["impact_analysis", { symbolName: "RateLimiter", changeType: "modify" }],
  ];

  for (const [toolName, params] of EXISTING_TOOLS) {
    it(`${toolName} returns MCPToolResponse with summary field`, async () => {
      const adapter = createMockAdapter();

      const response = await executeTool(toolName, params, adapter);

      expect(typeof response.summary).toBe("string");
      expect(response.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(response.symbols)).toBe(true);
      expect(Array.isArray(response.clusters)).toBe(true);
      expect(Array.isArray(response.processes)).toBe(true);
      expect(typeof response.confidence).toBe("number");
      expect(response.confidence).toBeGreaterThanOrEqual(0);
      expect(response.confidence).toBeLessThanOrEqual(1);
    });
  }
});
