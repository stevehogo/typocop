/**
 * Integration tests — MCP natural language search (smart_search).
 *
 * Covers:
 *   6.1 tools/list response includes smart_search (Req 1.8)
 *   6.2 smart_search against live pgvector returns results (Req 1.2, 2.1)
 *   6.3 Existing four tools still return valid MCPToolResponse (Req 3.1)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Driver, Session } from "neo4j-driver";
import type { Pool, PoolClient } from "pg";
import { createMCPServer } from "../../src/mcp/registration.js";
import { SessionManager } from "../../src/mcp/session-manager.js";
import { executeTool } from "../../src/mcp/tools.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// ---------------------------------------------------------------------------
// Mock query modules for non-regression tests (6.3)
// ---------------------------------------------------------------------------

vi.mock("../../src/query/context-retrieval.js", () => ({
  executeContextRetrieval: vi.fn(),
}));
vi.mock("../../src/query/impact-analysis.js", () => ({
  executeImpactAnalysis: vi.fn(),
}));
vi.mock("../../src/query/data-flow-trace.js", () => ({
  executeDataFlowTrace: vi.fn(),
}));

import { executeContextRetrieval } from "../../src/query/context-retrieval.js";
import { executeImpactAnalysis } from "../../src/query/impact-analysis.js";
import { executeDataFlowTrace } from "../../src/query/data-flow-trace.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STUB_QUERY_RESULT = {
  symbols: [
    {
      id: "sym-1",
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

function makeMockSession(): Session {
  return { close: vi.fn().mockResolvedValue(undefined) } as unknown as Session;
}

function makeMockDriver(session?: Session): Driver {
  const s = session ?? makeMockSession();
  return { session: vi.fn().mockReturnValue(s) } as unknown as Driver;
}

function makeMockPool(): Pool {
  return {} as unknown as Pool;
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
      expect(toolNames).toContain("find_dependents");
      expect(toolNames).toContain("trace_data_flow");
      expect(toolNames).toContain("impact_analysis");
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
// 6.2 — smart_search against live pgvector (Req 1.2, 2.1)
// ---------------------------------------------------------------------------

describe("6.2 smart_search against live pgvector", () => {
  it("returns symbols.length > 0 and confidence >= 0.5 for 'ip rate limiting'", async () => {
    // Attempt live DB connection — skip gracefully if unavailable
    const pg = await import("pg");
    const pool = new pg.Pool({
      host: "localhost",
      port: 8432,
      database: "tpc_teravexa",
      user: "typocop",
      password: "typocop1234QWA",
      connectionTimeoutMillis: 3000,
    });

    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
    } catch {
      await pool.end();
      return; // skip — DB not available
    } finally {
      client?.release();
    }

    // DB is available — also need Neo4j
    const neo4j = await import("neo4j-driver");
    const driver = neo4j.default.driver(
      "bolt://localhost:8687",
      neo4j.default.auth.basic("neo4j", "353LMz9vkNhhu"),
      { connectionTimeout: 3000 },
    );

    let neo4jAvailable = false;
    try {
      await driver.verifyConnectivity();
      neo4jAvailable = true;
    } catch {
      // Neo4j unavailable — skip
    }

    if (!neo4jAvailable) {
      await driver.close();
      await pool.end();
      return;
    }

    const sessionManager = new SessionManager();
    try {
      const response = await executeTool(
        "smart_search",
        { query: "ip rate limiting" },
        pool,
        driver,
        sessionManager,
      );

      expect(response.symbols.length).toBeGreaterThan(0);
      expect(response.confidence).toBeGreaterThanOrEqual(0.5);
      expect(typeof response.summary).toBe("string");
      expect(response.summary.length).toBeGreaterThan(0);
    } finally {
      await sessionManager.closeAll();
      await driver.close();
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// 6.3 — Non-regression: existing tools return valid MCPToolResponse (Req 3.1)
// ---------------------------------------------------------------------------

describe("6.3 existing tools return valid MCPToolResponse", () => {
  const EXISTING_TOOLS: Array<[string, Record<string, unknown>]> = [
    ["get_symbol_context", { symbolName: "RateLimiter" }],
    ["find_dependents", { symbolName: "RateLimiter" }],
    ["trace_data_flow", { entryPoint: "RateLimiterController.check" }],
    ["impact_analysis", { symbolName: "RateLimiter", changeType: "modify" }],
  ];

  for (const [toolName, params] of EXISTING_TOOLS) {
    it(`${toolName} returns MCPToolResponse with summary field`, async () => {
      const sessionManager = new SessionManager();
      const driver = makeMockDriver();
      const pool = makeMockPool();

      const response = await executeTool(toolName, params, pool, driver, sessionManager);

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
