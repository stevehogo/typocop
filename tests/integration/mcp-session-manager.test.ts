/**
 * Integration tests — SessionManager wired into MCP server.
 *
 * Covers:
 *   - Full tool call flow: MCPToolResponse shape (summary field present)
 *   - Two concurrent tool calls: neither hangs, both return results
 *   - Simulated disconnect mid-call: closeAll invoked, subsequent calls succeed
 *
 * Requirements: 2.1, 2.2, 2.3, 3.1, 3.2
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Driver, Session } from "neo4j-driver";
import type { Pool } from "pg";
import { SessionManager } from "../../src/mcp/session-manager.js";
import { executeTool } from "../../src/mcp/tools.js";

// ---------------------------------------------------------------------------
// Mock query modules — no real network calls
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

/** Minimal QueryResult stub returned by mocked query functions. */
const STUB_QUERY_RESULT = {
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

function makeMockSession(): Session {
  return {
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Session;
}

function makeMockDriver(session?: Session): Driver {
  const s = session ?? makeMockSession();
  return {
    session: vi.fn().mockReturnValue(s),
  } as unknown as Driver;
}

function makeMockPool(): Pool {
  return {} as unknown as Pool;
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

describe("full tool call flow", () => {
  it("get_symbol_context returns MCPToolResponse with summary field", async () => {
    const sessionManager = new SessionManager();
    const driver = makeMockDriver();
    const pool = makeMockPool();

    const response = await executeTool(
      "get_symbol_context",
      { symbolName: "UserService" },
      pool,
      driver,
      sessionManager,
    );

    expect(response.summary).toBeDefined();
    expect(typeof response.summary).toBe("string");
    expect(response.summary.length).toBeGreaterThan(0);
  });

  it("find_dependents returns MCPToolResponse with summary field", async () => {
    const sessionManager = new SessionManager();
    const driver = makeMockDriver();
    const pool = makeMockPool();

    const response = await executeTool(
      "find_dependents",
      { symbolName: "UserService" },
      pool,
      driver,
      sessionManager,
    );

    expect(response.summary).toBeDefined();
    expect(typeof response.summary).toBe("string");
    expect(response.summary.length).toBeGreaterThan(0);
  });

  it("trace_data_flow returns MCPToolResponse with summary field", async () => {
    const sessionManager = new SessionManager();
    const driver = makeMockDriver();
    const pool = makeMockPool();

    const response = await executeTool(
      "trace_data_flow",
      { entryPoint: "UserController.login" },
      pool,
      driver,
      sessionManager,
    );

    expect(response.summary).toBeDefined();
    expect(typeof response.summary).toBe("string");
    expect(response.summary.length).toBeGreaterThan(0);
  });

  it("impact_analysis returns MCPToolResponse with summary field", async () => {
    const sessionManager = new SessionManager();
    const driver = makeMockDriver();
    const pool = makeMockPool();

    const response = await executeTool(
      "impact_analysis",
      { symbolName: "UserService", changeType: "modify" },
      pool,
      driver,
      sessionManager,
    );

    expect(response.summary).toBeDefined();
    expect(typeof response.summary).toBe("string");
    expect(response.summary.length).toBeGreaterThan(0);
  });

  it("response includes symbols, clusters, processes, confidence, and riskLevel", async () => {
    const sessionManager = new SessionManager();
    const driver = makeMockDriver();
    const pool = makeMockPool();

    const response = await executeTool(
      "get_symbol_context",
      { symbolName: "UserService" },
      pool,
      driver,
      sessionManager,
    );

    expect(Array.isArray(response.symbols)).toBe(true);
    expect(Array.isArray(response.clusters)).toBe(true);
    expect(Array.isArray(response.processes)).toBe(true);
    expect(typeof response.confidence).toBe("number");
    expect(response.confidence).toBeGreaterThanOrEqual(0);
    expect(response.confidence).toBeLessThanOrEqual(1);
    expect(response.riskLevel).toBeDefined();
  });

  it("session is closed after a successful tool call (finally block)", async () => {
    const mockSession = makeMockSession();
    const sessionManager = new SessionManager();
    const driver = makeMockDriver(mockSession);
    const pool = makeMockPool();

    await executeTool(
      "get_symbol_context",
      { symbolName: "UserService" },
      pool,
      driver,
      sessionManager,
    );

    expect(mockSession.close).toHaveBeenCalledOnce();
    expect(sessionManager.openCount()).toBe(0);
  });

  it("session is closed even when the query throws (error propagation preserved)", async () => {
    vi.mocked(executeContextRetrieval).mockRejectedValueOnce(new Error("query failed"));

    const mockSession = makeMockSession();
    const sessionManager = new SessionManager();
    const driver = makeMockDriver(mockSession);
    const pool = makeMockPool();

    await expect(
      executeTool("get_symbol_context", { symbolName: "BrokenSymbol" }, pool, driver, sessionManager),
    ).rejects.toThrow("query failed");

    // Session must still be closed despite the error (Req 3.2)
    expect(mockSession.close).toHaveBeenCalledOnce();
    expect(sessionManager.openCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Two concurrent tool calls — neither hangs, both return results
// ---------------------------------------------------------------------------

describe("concurrent tool calls", () => {
  it("two concurrent get_symbol_context calls both return results without hanging", async () => {
    const session1 = makeMockSession();
    const session2 = makeMockSession();
    const sessionManager = new SessionManager();
    const driver = {
      session: vi.fn().mockReturnValueOnce(session1).mockReturnValueOnce(session2),
    } as unknown as Driver;
    const pool = makeMockPool();

    // Dispatch both concurrently — SessionManager serializes them
    const [result1, result2] = await Promise.all([
      executeTool("get_symbol_context", { symbolName: "ServiceA" }, pool, driver, sessionManager),
      executeTool("get_symbol_context", { symbolName: "ServiceB" }, pool, driver, sessionManager),
    ]);

    expect(result1.summary).toBeDefined();
    expect(result2.summary).toBeDefined();
  });

  it("openCount never exceeds 1 during two concurrent tool calls", async () => {
    const peakCounts: number[] = [];

    // Intercept acquire to record openCount after each session opens
    const session1 = makeMockSession();
    const session2 = makeMockSession();
    const sessionManager = new SessionManager();

    const originalAcquire = sessionManager.acquire.bind(sessionManager);
    vi.spyOn(sessionManager, "acquire").mockImplementation(async (driver) => {
      const s = await originalAcquire(driver);
      peakCounts.push(sessionManager.openCount());
      return s;
    });

    const driver = {
      session: vi.fn().mockReturnValueOnce(session1).mockReturnValueOnce(session2),
    } as unknown as Driver;
    const pool = makeMockPool();

    await Promise.all([
      executeTool("get_symbol_context", { symbolName: "ServiceA" }, pool, driver, sessionManager),
      executeTool("find_dependents", { symbolName: "ServiceB" }, pool, driver, sessionManager),
    ]);

    expect(Math.max(...peakCounts)).toBeLessThanOrEqual(1);
  });

  it("second call executes after first completes (serialization order)", async () => {
    const callOrder: string[] = [];

    vi.mocked(executeContextRetrieval)
      .mockImplementationOnce(async () => {
        callOrder.push("call-1-start");
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push("call-1-end");
        return STUB_QUERY_RESULT;
      })
      .mockImplementationOnce(async () => {
        callOrder.push("call-2-start");
        return STUB_QUERY_RESULT;
      });

    const session1 = makeMockSession();
    const session2 = makeMockSession();
    const sessionManager = new SessionManager();
    const driver = {
      session: vi.fn().mockReturnValueOnce(session1).mockReturnValueOnce(session2),
    } as unknown as Driver;
    const pool = makeMockPool();

    await Promise.all([
      executeTool("get_symbol_context", { symbolName: "A" }, pool, driver, sessionManager),
      executeTool("get_symbol_context", { symbolName: "B" }, pool, driver, sessionManager),
    ]);

    // call-2 must start only after call-1 ends (serialization)
    expect(callOrder.indexOf("call-1-end")).toBeLessThan(callOrder.indexOf("call-2-start"));
  });
});

// ---------------------------------------------------------------------------
// 3. Simulated disconnect mid-call — closeAll invoked, subsequent calls succeed
// ---------------------------------------------------------------------------

describe("simulated disconnect", () => {
  it("closeAll reduces openCount to 0 when called mid-call", async () => {
    let resolveQuery!: () => void;
    vi.mocked(executeContextRetrieval).mockImplementationOnce(
      () => new Promise<typeof STUB_QUERY_RESULT>((resolve) => {
        resolveQuery = () => resolve(STUB_QUERY_RESULT);
      }),
    );

    const mockSession = makeMockSession();
    const sessionManager = new SessionManager();
    const driver = makeMockDriver(mockSession);
    const pool = makeMockPool();

    // Start a tool call but don't await it yet
    const toolCallPromise = executeTool(
      "get_symbol_context",
      { symbolName: "SlowSymbol" },
      pool,
      driver,
      sessionManager,
    );

    // Give the acquire a tick to run
    await new Promise((r) => setTimeout(r, 0));

    // Simulate disconnect — closeAll must close the in-flight session
    await sessionManager.closeAll();
    expect(sessionManager.openCount()).toBe(0);
    expect(mockSession.close).toHaveBeenCalled();

    // Resolve the in-flight query so the test can clean up
    resolveQuery();
    await toolCallPromise.catch(() => {/* session already closed — ignore */});
  });

  it("subsequent calls succeed after a simulated disconnect", async () => {
    const sessionManager = new SessionManager();
    const session1 = makeMockSession();
    const session2 = makeMockSession();
    const driver = {
      session: vi.fn().mockReturnValueOnce(session1).mockReturnValueOnce(session2),
    } as unknown as Driver;
    const pool = makeMockPool();

    // First call completes normally
    await executeTool("get_symbol_context", { symbolName: "ServiceA" }, pool, driver, sessionManager);

    // Simulate disconnect
    await sessionManager.closeAll();
    expect(sessionManager.openCount()).toBe(0);

    // Subsequent call must succeed (queue reset by closeAll)
    const response = await executeTool(
      "find_dependents",
      { symbolName: "ServiceB" },
      pool,
      driver,
      sessionManager,
    );

    expect(response.summary).toBeDefined();
    expect(sessionManager.openCount()).toBe(0);
  });

  it("closeAll is a no-op when no sessions are open (does not throw)", async () => {
    const sessionManager = new SessionManager();
    await expect(sessionManager.closeAll()).resolves.toBeUndefined();
    expect(sessionManager.openCount()).toBe(0);
  });

  it("multiple disconnect cycles leave openCount at 0 each time", async () => {
    const sessionManager = new SessionManager();
    const pool = makeMockPool();

    for (let i = 0; i < 3; i++) {
      const mockSession = makeMockSession();
      const driver = makeMockDriver(mockSession);

      // Start a call, then disconnect before it finishes
      let resolveQuery!: () => void;
      vi.mocked(executeContextRetrieval).mockImplementationOnce(
        () => new Promise<typeof STUB_QUERY_RESULT>((resolve) => {
          resolveQuery = () => resolve(STUB_QUERY_RESULT);
        }),
      );

      const callPromise = executeTool(
        "get_symbol_context",
        { symbolName: `Symbol${i}` },
        pool,
        driver,
        sessionManager,
      );

      await new Promise((r) => setTimeout(r, 0));
      await sessionManager.closeAll();

      expect(sessionManager.openCount()).toBe(0);

      resolveQuery();
      await callPromise.catch(() => {/* ignore */});
    }
  });
});
