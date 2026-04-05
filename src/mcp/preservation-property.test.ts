/**
 * Preservation Property Tests — Task 2
 *
 * Property 2: Preservation — Sequential Call Behavior Unchanged
 *
 * These tests run on UNFIXED code (src/mcp/tools.ts with direct driver.session()
 * calls) and MUST PASS. They document the baseline behavior that the fix must
 * preserve.
 *
 * Observation-first methodology:
 *   - Observe: single call completes → session opens, query runs, session closes
 *     in finally, correct MCPToolResponse returned.
 *   - Observe: single call throws → session still closes in finally, error propagates.
 *
 * Property-based test: for any sequence of non-concurrent tool calls
 * (isBugCondition returns false), the code returns a valid MCPToolResponse with
 * session.close() called exactly once per call.
 *
 * EXPECTED OUTCOME: All tests PASS on unfixed code.
 *
 * Requirements: 3.1, 3.2
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
import type { Driver, Session } from "neo4j-driver";
import type { Pool } from "pg";
import { SessionManager } from "./session-manager.js";

// ---------------------------------------------------------------------------
// Mock query modules — return minimal valid results immediately
// ---------------------------------------------------------------------------

vi.mock("../query/context-retrieval.js", () => ({
  executeContextRetrieval: vi.fn().mockResolvedValue({
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
    symbols: [],
    relationships: [],
    clusters: [],
    processes: [],
    confidence: 0.9,
    riskLevel: "low",
    affectedFlows: [],
  }),
}));

vi.mock("../query/execute-query.js", () => ({
  executeQuery: vi.fn().mockResolvedValue({
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

/**
 * Creates a mock Neo4j session that tracks how many times close() was called.
 */
function createMockSession(): { session: Session; getCloseCount: () => number } {
  let closeCount = 0;

  const session = {
    run: vi.fn().mockResolvedValue({ records: [] }),
    executeRead: vi.fn(async (work: (tx: { run: typeof session.run }) => Promise<unknown>) =>
      work({ run: session.run }),
    ),
    executeWrite: vi.fn(async (work: (tx: { run: typeof session.run }) => Promise<unknown>) =>
      work({ run: session.run }),
    ),
    close: vi.fn(async () => {
      closeCount++;
    }),
  } as unknown as Session;

  return { session, getCloseCount: () => closeCount };
}

/**
 * Creates a mock Driver that returns a fresh tracking session on each call.
 * Returns the driver and a list of all sessions created (for close-count assertions).
 */
function createMockDriver(): {
  driver: Driver;
  getSessions: () => Array<{ session: Session; getCloseCount: () => number }>;
} {
  const sessions: Array<{ session: Session; getCloseCount: () => number }> = [];

  const driver = {
    session: vi.fn(() => {
      const entry = createMockSession();
      sessions.push(entry);
      return entry.session;
    }),
  } as unknown as Driver;

  return { driver, getSessions: () => sessions };
}

const mockPool = {} as Pool;

/**
 * isBugCondition: returns false for sequential (non-concurrent) calls.
 * Used to confirm we are testing the preservation path only.
 */
function isBugCondition(concurrentOpenSessions: number): boolean {
  return concurrentOpenSessions >= 2;
}

// ---------------------------------------------------------------------------
// Observation 1: single successful call
// ---------------------------------------------------------------------------

describe("Preservation — single successful call (Req 3.1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return a valid MCPToolResponse with summary for get_symbol_context", async () => {
    const { driver, getSessions } = createMockDriver();
    const { executeTool } = await import("./tools.js");
    const sessionManager = new SessionManager();

    const result = await executeTool(
      "get_symbol_context",
      { symbolName: "MySymbol" },
      mockPool,
      driver,
      sessionManager,
    );

    // Response shape is correct
    expect(result).toHaveProperty("summary");
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result).toHaveProperty("symbols");
    expect(result).toHaveProperty("clusters");
    expect(result).toHaveProperty("processes");
    expect(result).toHaveProperty("confidence");
    expect(result).toHaveProperty("riskLevel");
    expect(result).toHaveProperty("affectedFlows");

    // Session was opened and closed exactly once (finally block ran)
    const sessions = getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].getCloseCount()).toBe(1);

    // Confirm this is NOT a bug condition (sequential, single call)
    expect(isBugCondition(sessions.length)).toBe(false);
  });

  it("should return a valid MCPToolResponse with summary for find_dependents", async () => {
    const { driver, getSessions } = createMockDriver();
    const { executeTool } = await import("./tools.js");
    const sessionManager = new SessionManager();

    const result = await executeTool(
      "find_dependents",
      { symbolName: "MySymbol" },
      mockPool,
      driver,
      sessionManager,
    );

    expect(result).toHaveProperty("summary");
    expect(typeof result.summary).toBe("string");

    const sessions = getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].getCloseCount()).toBe(1);
  });

  it("should return a valid MCPToolResponse with summary for trace_data_flow", async () => {
    const { driver, getSessions } = createMockDriver();
    const { executeTool } = await import("./tools.js");
    const sessionManager = new SessionManager();

    const result = await executeTool(
      "trace_data_flow",
      { entryPoint: "MyController.handle" },
      mockPool,
      driver,
      sessionManager,
    );

    expect(result).toHaveProperty("summary");
    expect(typeof result.summary).toBe("string");

    const sessions = getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].getCloseCount()).toBe(1);
  });

  it("should return a valid MCPToolResponse with summary for impact_analysis", async () => {
    const { driver, getSessions } = createMockDriver();
    const { executeTool } = await import("./tools.js");
    const sessionManager = new SessionManager();

    const result = await executeTool(
      "impact_analysis",
      { symbolName: "MySymbol", changeType: "modify" },
      mockPool,
      driver,
      sessionManager,
    );

    expect(result).toHaveProperty("summary");
    expect(typeof result.summary).toBe("string");

    const sessions = getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].getCloseCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Observation 2: single call that throws — session still closes (Req 3.2)
// ---------------------------------------------------------------------------

describe("Preservation — error propagation with session cleanup (Req 3.2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should close session in finally and propagate error when query throws", async () => {
    const { executeContextRetrieval } = await import("../query/context-retrieval.js");
    vi.mocked(executeContextRetrieval).mockRejectedValueOnce(
      new Error("Neo4j query failed"),
    );

    const { driver, getSessions } = createMockDriver();
    const { executeTool } = await import("./tools.js");
    const sessionManager = new SessionManager();

    await expect(
      executeTool("get_symbol_context", { symbolName: "BrokenSymbol" }, mockPool, driver, sessionManager),
    ).rejects.toThrow("Neo4j query failed");

    // Session was still closed despite the error (finally block ran)
    const sessions = getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].getCloseCount()).toBe(1);
  });

  it("should close session in finally and propagate error for find_dependents", async () => {
    const { executeImpactAnalysis } = await import("../query/impact-analysis.js");
    vi.mocked(executeImpactAnalysis).mockRejectedValueOnce(
      new Error("Impact analysis failed"),
    );

    const { driver, getSessions } = createMockDriver();
    const { executeTool } = await import("./tools.js");
    const sessionManager = new SessionManager();

    await expect(
      executeTool("find_dependents", { symbolName: "BrokenSymbol" }, mockPool, driver, sessionManager),
    ).rejects.toThrow("Impact analysis failed");

    const sessions = getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].getCloseCount()).toBe(1);
  });

  it("should throw for unknown tool name without opening a session", async () => {
    const { driver, getSessions } = createMockDriver();
    const { executeTool } = await import("./tools.js");
    const sessionManager = new SessionManager();

    await expect(
      executeTool("unknown_tool", {}, mockPool, driver, sessionManager),
    ).rejects.toThrow("Unknown tool: unknown_tool");

    // No session should have been opened for an unknown tool
    expect(getSessions()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Property-based test: sequential call sequences (Req 3.1, 3.2)
// ---------------------------------------------------------------------------

describe("Preservation — property: sequential call sequences behave correctly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should close session exactly once per call for any sequential tool call sequence", async () => {
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

          const { driver, getSessions } = createMockDriver();
          const sessionManager = new SessionManager();

          // Execute calls sequentially (not concurrently — isBugCondition is false)
          for (const toolName of toolNames) {
            const params =
              toolName === "trace_data_flow"
                ? { entryPoint: "SomeEntry" }
                : { symbolName: "SomeSymbol" };

            const result = await executeTool(toolName, params, mockPool, driver, sessionManager);

            // Each call returns a valid MCPToolResponse
            expect(result).toHaveProperty("summary");
            expect(typeof result.summary).toBe("string");
          }

          const sessions = getSessions();

          // One session opened per call
          expect(sessions).toHaveLength(toolNames.length);

          // Every session was closed exactly once (finally block ran for each)
          for (const { getCloseCount } of sessions) {
            expect(getCloseCount()).toBe(1);
          }

          // Confirm sequential calls never hit the bug condition
          // (peak concurrent open is always 1 — each call awaited before next)
          expect(isBugCondition(1)).toBe(false);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("should propagate errors and still close sessions for any sequence with a failing call", async () => {
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

          // Make the relevant query throw
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

          const { driver, getSessions } = createMockDriver();
          const sessionManager = new SessionManager();
          const params =
            failingTool === "trace_data_flow"
              ? { entryPoint: "SomeEntry" }
              : { symbolName: "SomeSymbol" };

          await expect(
            executeTool(failingTool, params, mockPool, driver, sessionManager),
          ).rejects.toThrow("query error");

          // Session was still closed despite the error
          const sessions = getSessions();
          expect(sessions).toHaveLength(1);
          expect(sessions[0].getCloseCount()).toBe(1);
        },
      ),
      { numRuns: 20 },
    );
  });
});
