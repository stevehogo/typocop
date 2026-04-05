/**
 * Bug Condition Exploration Test — Task 1
 *
 * Property 1: Bug Condition — Concurrent Sessions + Zombie on Disconnect
 *
 * These tests verify the FIXED behavior (src/mcp/tools.ts with SessionManager).
 * They were written to FAIL on unfixed code and PASS after the fix.
 *
 * Two cases:
 *   Case A — Concurrent race: two executeGetSymbolContext calls must NOT open
 *             two sessions simultaneously (SessionManager serializes access).
 *   Case B — Zombie on disconnect: after closeAll() is called, openCount must
 *             be 0 (no zombie transactions).
 *
 * Requirements: 1.1, 1.2
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Driver, Session } from "neo4j-driver";
import type { Pool } from "pg";
import { SessionManager } from "./session-manager.js";

// ---------------------------------------------------------------------------
// Session tracking infrastructure
// ---------------------------------------------------------------------------

/**
 * Creates a mock Neo4j session factory that records open/close lifecycle.
 * Returns the factory and a shared counter so tests can observe concurrency.
 */
function createTrackingSessionFactory() {
  let openCount = 0;
  let peakConcurrentOpen = 0;

  function makeSession(): Session {
    openCount++;
    if (openCount > peakConcurrentOpen) {
      peakConcurrentOpen = openCount;
    }

    const session = {
      run: vi.fn().mockResolvedValue({ records: [] }),
      executeRead: vi.fn(async (work: (tx: { run: typeof session.run }) => Promise<unknown>) =>
        work({ run: session.run }),
      ),
      executeWrite: vi.fn(async (work: (tx: { run: typeof session.run }) => Promise<unknown>) =>
        work({ run: session.run }),
      ),
      close: vi.fn(async () => {
        openCount--;
      }),
    } as unknown as Session;

    return session;
  }

  return {
    makeSession,
    getOpenCount: () => openCount,
    getPeakConcurrentOpen: () => peakConcurrentOpen,
    reset: () => {
      openCount = 0;
      peakConcurrentOpen = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// isBugCondition helpers (formal spec from design.md)
// ---------------------------------------------------------------------------

function isBugConditionConcurrent(peakConcurrentOpen: number): boolean {
  // Bug: a second call arrived while one was already in flight
  return peakConcurrentOpen >= 2;
}

function isBugConditionZombie(openCountOnDisconnect: number): boolean {
  // Bug: sessions were left open when the connection closed
  return openCountOnDisconnect > 0;
}

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
// Tests
// ---------------------------------------------------------------------------

describe("Bug Condition Exploration — fixed tools.ts with SessionManager", () => {
  /**
   * Case A — Concurrent race (fixed)
   *
   * Dispatch two executeGetSymbolContext calls concurrently.
   * With SessionManager the second call waits for the first to release before
   * opening its session → peakConcurrentOpen stays at 1.
   *
   * EXPECTED: test PASSES on fixed code.
   */
  describe("Case A — concurrent session race", () => {
    it("should have at most 1 session open at any instant during concurrent calls (FAILS on unfixed code)", async () => {
      const tracker = createTrackingSessionFactory();

      // We need to control when the query resolves so both sessions are open
      // simultaneously. Use a latch: first call opens its session and waits,
      // second call opens its session, then both are released.
      let resolveFirst!: () => void;
      const firstCallBlocked = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });

      const { executeContextRetrieval } = await import("../query/context-retrieval.js");
      const mockExecute = vi.mocked(executeContextRetrieval);

      let callCount = 0;
      mockExecute.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First call: block until second call has started
          await firstCallBlocked;
        }
        return {
          symbols: [],
          relationships: [],
          clusters: [],
          processes: [],
          confidence: 0.9,
          riskLevel: "low" as const,
          affectedFlows: [],
        };
      });

      const mockDriver = {
        session: vi.fn(() => {
          const session = tracker.makeSession();
          // On unfixed code: after second session opens, unblock the first call.
          // On fixed code: this never reaches 2 because SessionManager serializes.
          if (tracker.getOpenCount() >= 2) {
            resolveFirst();
          }
          return session;
        }),
      } as unknown as Driver;

      const mockPool = {} as Pool;

      // Dynamically import tools so vi.mock above takes effect
      const { executeTool } = await import("./tools.js");
      const sessionManager = new SessionManager();

      // After the first acquire blocks, we need to unblock it so the second
      // call can proceed. Since SessionManager serializes, the second call
      // won't even open a session until the first releases. Unblock first call
      // after a short delay to let both calls be dispatched.
      setTimeout(() => resolveFirst(), 10);

      // Dispatch two concurrent calls
      const [result1, result2] = await Promise.all([
        executeTool("get_symbol_context", { symbolName: "SymbolA" }, mockPool, mockDriver, sessionManager),
        executeTool("get_symbol_context", { symbolName: "SymbolB" }, mockPool, mockDriver, sessionManager),
      ]);

      const peak = tracker.getPeakConcurrentOpen();

      // Document the counterexample
      if (isBugConditionConcurrent(peak)) {
        console.log(
          `[BUG CONFIRMED] Case A counterexample: peakConcurrentOpen=${peak} ` +
          `(expected <= 1). Two sessions were open simultaneously.`,
        );
      }

      // This assertion PASSES on fixed code because SessionManager serializes.
      expect(peak).toBeLessThanOrEqual(1);

      // Sanity: both calls still returned valid responses
      expect(result1).toHaveProperty("summary");
      expect(result2).toHaveProperty("summary");
    });
  });

  /**
   * Case B — Zombie on disconnect (fixed)
   *
   * Start a tool call, simulate a disconnect by calling sessionManager.closeAll()
   * before the call completes. The session count must drop to 0.
   *
   * EXPECTED: test PASSES on fixed code (closeAll() closes the open session).
   */
  describe("Case B — zombie session on disconnect", () => {
    it("should have 0 open sessions after a simulated disconnect (FAILS on unfixed code)", async () => {
      const tracker = createTrackingSessionFactory();

      // A latch that lets us know the tool call has opened its session
      let resolveSessionOpened!: () => void;
      const sessionOpened = new Promise<void>((resolve) => {
        resolveSessionOpened = resolve;
      });

      // The query never resolves — simulates an in-flight call
      const neverResolves = new Promise<never>(() => {/* intentionally hangs */});

      const { executeContextRetrieval } = await import("../query/context-retrieval.js");
      vi.mocked(executeContextRetrieval).mockImplementation(() => {
        resolveSessionOpened();
        return neverResolves;
      });

      const mockDriver = {
        session: vi.fn(() => {
          return tracker.makeSession();
        }),
      } as unknown as Driver;

      const mockPool = {} as Pool;
      const { executeTool } = await import("./tools.js");
      const sessionManager = new SessionManager();

      // Start the tool call but do NOT await it — simulates the MCP transport
      // dropping the connection mid-call.
      const toolCallPromise = executeTool(
        "get_symbol_context",
        { symbolName: "SymbolC" },
        mockPool,
        mockDriver,
        sessionManager,
      );

      // Wait until the session has been opened
      await sessionOpened;

      // Session is open and query is in-flight.
      // Simulate disconnect: call closeAll() as the transport close handler would.
      await sessionManager.closeAll();

      const openCountAfterDisconnect = sessionManager.openCount();

      if (isBugConditionZombie(openCountAfterDisconnect)) {
        console.log(
          `[BUG CONFIRMED] Case B counterexample: openCountOnDisconnect=${openCountAfterDisconnect} ` +
          `(expected 0). Session is still open after simulated disconnect — zombie transaction.`,
        );
      }

      // This assertion PASSES on fixed code because closeAll() closed the session.
      expect(openCountAfterDisconnect).toBe(0);

      // Cleanup: prevent the hanging promise from leaking into other tests.
      void toolCallPromise;
    });
  });
});
