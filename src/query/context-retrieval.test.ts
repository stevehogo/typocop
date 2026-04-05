/**
 * Unit tests for context retrieval query logic.
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, ManagedTransaction } from "neo4j-driver";
import { executeContextRetrieval } from "./context-retrieval.js";
import * as graphQuery from "../graph/query.js";
import type { GraphNode } from "../graph/connection.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../graph/query.js", () => ({
  txFindNode: vi.fn(),
  txFindDependents: vi.fn(),
  txFindDependencies: vi.fn(),
  txFindProcessesBySymbol: vi.fn(),
  txFindClustersBySymbol: vi.fn(),
  txFindProcessSteps: vi.fn().mockResolvedValue([]),
}));

// ─── Test Data ────────────────────────────────────────────────────────────────

const mockTargetNode: GraphNode = {
  id: "target-symbol-id",
  labels: ["Symbol"],
  properties: {
    id: "target-symbol-id",
    name: "targetFunction",
    kind: "function",
    filePath: "/src/target.ts",
    startLine: "10",
    startColumn: "0",
    endLine: "20",
    endColumn: "0",
    visibility: "public",
  },
};

const mockCallerNode: GraphNode = {
  id: "caller-symbol-id",
  labels: ["Symbol"],
  properties: {
    id: "caller-symbol-id",
    name: "callerFunction",
    kind: "function",
    filePath: "/src/caller.ts",
    startLine: "5",
    startColumn: "0",
    endLine: "15",
    endColumn: "0",
    visibility: "public",
  },
};

const mockCalleeNode: GraphNode = {
  id: "callee-symbol-id",
  labels: ["Symbol"],
  properties: {
    id: "callee-symbol-id",
    name: "calleeFunction",
    kind: "function",
    filePath: "/src/callee.ts",
    startLine: "30",
    startColumn: "0",
    endLine: "40",
    endColumn: "0",
    visibility: "public",
  },
};

const mockProcessNode: GraphNode = {
  id: "process-id",
  labels: ["Process"],
  properties: {
    id: "process-id",
    name: "UserRegistrationFlow",
    entryPoint: "target-symbol-id",
  },
};

const mockClusterNode: GraphNode = {
  id: "cluster-id",
  labels: ["Cluster"],
  properties: {
    id: "cluster-id",
    name: "AuthenticationCluster",
    confidence: "0.92",
    category: "authentication",
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a session whose executeRead invokes the callback with a stub tx. */
function makeSession(): Session {
  const mockTx = {} as ManagedTransaction;
  return {
    executeRead: vi.fn().mockImplementation((cb: (tx: ManagedTransaction) => Promise<unknown>) => cb(mockTx)),
  } as unknown as Session;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("executeContextRetrieval", () => {
  let mockSession: Session;

  beforeEach(() => {
    mockSession = makeSession();
    vi.clearAllMocks();
    // Re-attach executeRead after clearAllMocks
    const mockTx = {} as ManagedTransaction;
    (mockSession as unknown as { executeRead: ReturnType<typeof vi.fn> }).executeRead =
      vi.fn().mockImplementation((cb: (tx: ManagedTransaction) => Promise<unknown>) => cb(mockTx));
  });

  /**
   * Req 12.1: Identify target symbol
   */
  it("returns empty result when target symbol not found", async () => {
    vi.mocked(graphQuery.txFindNode).mockResolvedValue(null);

    const result = await executeContextRetrieval("nonexistent-id", 10, mockSession);

    expect(result.symbols).toEqual([]);
    expect(result.relationships).toEqual([]);
    expect(result.clusters).toEqual([]);
    expect(result.processes).toEqual([]);
    expect(result.confidence).toBe(0.5);
    expect(result.riskLevel).toBe("low");
  });

  /**
   * Req 12.2: Find all callers using txFindDependents
   */
  it("finds all callers of the target symbol", async () => {
    vi.mocked(graphQuery.txFindNode).mockResolvedValue(mockTargetNode);
    vi.mocked(graphQuery.txFindDependents).mockResolvedValue([mockCallerNode]);
    vi.mocked(graphQuery.txFindDependencies).mockResolvedValue([]);
    vi.mocked(graphQuery.txFindProcessesBySymbol).mockResolvedValue([]);
    vi.mocked(graphQuery.txFindClustersBySymbol).mockResolvedValue([]);

    const result = await executeContextRetrieval("target-symbol-id", 10, mockSession);

    expect(result.symbols).toHaveLength(2); // target + caller
    expect(result.symbols.some((s) => s.id === "caller-symbol-id")).toBe(true);
    expect(result.relationships.some((r) => r.source === "caller-symbol-id" && r.target === "target-symbol-id")).toBe(true);
  });

  /**
   * Req 12.3: Find all callees using txFindDependencies
   */
  it("finds all callees of the target symbol", async () => {
    vi.mocked(graphQuery.txFindNode).mockResolvedValue(mockTargetNode);
    vi.mocked(graphQuery.txFindDependents).mockResolvedValue([]);
    vi.mocked(graphQuery.txFindDependencies).mockResolvedValue([mockCalleeNode]);
    vi.mocked(graphQuery.txFindProcessesBySymbol).mockResolvedValue([]);
    vi.mocked(graphQuery.txFindClustersBySymbol).mockResolvedValue([]);

    const result = await executeContextRetrieval("target-symbol-id", 10, mockSession);

    expect(result.symbols).toHaveLength(2); // target + callee
    expect(result.symbols.some((s) => s.id === "callee-symbol-id")).toBe(true);
    expect(result.relationships.some((r) => r.source === "target-symbol-id" && r.target === "callee-symbol-id")).toBe(true);
  });

  /**
   * Req 12.4: Find all processes containing the symbol
   */
  it("finds all processes containing the target symbol", async () => {
    vi.mocked(graphQuery.txFindNode).mockResolvedValue(mockTargetNode);
    vi.mocked(graphQuery.txFindDependents).mockResolvedValue([]);
    vi.mocked(graphQuery.txFindDependencies).mockResolvedValue([]);
    vi.mocked(graphQuery.txFindProcessesBySymbol).mockResolvedValue([mockProcessNode]);
    vi.mocked(graphQuery.txFindClustersBySymbol).mockResolvedValue([]);
    vi.mocked(graphQuery.txFindProcessSteps).mockResolvedValue([]);

    const result = await executeContextRetrieval("target-symbol-id", 10, mockSession);

    expect(result.processes).toHaveLength(1);
    expect(result.processes[0].id).toBe("process-id");
    expect(result.processes[0].name).toBe("UserRegistrationFlow");
    expect(result.affectedFlows).toContain("UserRegistrationFlow");
  });

  /**
   * Req 12.5: Find all clusters containing the symbol
   */
  it("finds all clusters containing the target symbol", async () => {
    vi.mocked(graphQuery.txFindNode).mockResolvedValue(mockTargetNode);
    vi.mocked(graphQuery.txFindDependents).mockResolvedValue([]);
    vi.mocked(graphQuery.txFindDependencies).mockResolvedValue([]);
    vi.mocked(graphQuery.txFindProcessesBySymbol).mockResolvedValue([]);
    vi.mocked(graphQuery.txFindClustersBySymbol).mockResolvedValue([mockClusterNode]);

    const result = await executeContextRetrieval("target-symbol-id", 10, mockSession);

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].id).toBe("cluster-id");
    expect(result.clusters[0].name).toBe("AuthenticationCluster");
    expect(result.clusters[0].category).toBe("authentication");
  });

  /**
   * Req 12.6: Return complete 360° context
   */
  it("returns complete 360° context with all relationships", async () => {
    vi.mocked(graphQuery.txFindNode).mockResolvedValue(mockTargetNode);
    vi.mocked(graphQuery.txFindDependents).mockResolvedValue([mockCallerNode]);
    vi.mocked(graphQuery.txFindDependencies).mockResolvedValue([mockCalleeNode]);
    vi.mocked(graphQuery.txFindProcessesBySymbol).mockResolvedValue([mockProcessNode]);
    vi.mocked(graphQuery.txFindClustersBySymbol).mockResolvedValue([mockClusterNode]);
    vi.mocked(graphQuery.txFindProcessSteps).mockResolvedValue([]);

    const result = await executeContextRetrieval("target-symbol-id", 10, mockSession);

    expect(result.symbols).toHaveLength(3); // target + caller + callee
    expect(result.relationships).toHaveLength(2); // caller->target, target->callee
    expect(result.clusters).toHaveLength(1);
    expect(result.processes).toHaveLength(1);
    expect(result.confidence).toBe(0.92);
    expect(result.riskLevel).toBe("low");
    expect(result.affectedFlows).toContain("UserRegistrationFlow");
  });

  /**
   * Confidence scoring: lower when no context found
   */
  it("returns lower confidence when no context is found", async () => {
    vi.mocked(graphQuery.txFindNode).mockResolvedValue(mockTargetNode);
    vi.mocked(graphQuery.txFindDependents).mockResolvedValue([]);
    vi.mocked(graphQuery.txFindDependencies).mockResolvedValue([]);
    vi.mocked(graphQuery.txFindProcessesBySymbol).mockResolvedValue([]);
    vi.mocked(graphQuery.txFindClustersBySymbol).mockResolvedValue([]);

    const result = await executeContextRetrieval("target-symbol-id", 10, mockSession);

    expect(result.symbols).toHaveLength(1); // only target
    expect(result.confidence).toBe(0.75);
  });

  /**
   * Respects maxResults limit
   */
  it("respects maxResults limit for symbols", async () => {
    const manyCallers = Array.from({ length: 10 }, (_, i) => ({
      id: `caller-${i}`,
      labels: ["Symbol"],
      properties: {
        id: `caller-${i}`,
        name: `caller${i}`,
        kind: "function",
        filePath: `/src/caller${i}.ts`,
        startLine: "5",
        startColumn: "0",
        endLine: "15",
        endColumn: "0",
        visibility: "public",
      },
    }));

    vi.mocked(graphQuery.txFindNode).mockResolvedValue(mockTargetNode);
    vi.mocked(graphQuery.txFindDependents).mockResolvedValue(manyCallers);
    vi.mocked(graphQuery.txFindDependencies).mockResolvedValue([]);
    vi.mocked(graphQuery.txFindProcessesBySymbol).mockResolvedValue([]);
    vi.mocked(graphQuery.txFindClustersBySymbol).mockResolvedValue([]);

    const result = await executeContextRetrieval("target-symbol-id", 5, mockSession);

    expect(result.symbols.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Regression Test — Single-Transaction Consolidation (Req 2.6)
//
// 11.3: The bug: executeContextRetrieval previously made 5 separate
// session.executeRead() calls. In Neo4j driver v5+, a second executeRead()
// on a session with an open transaction throws:
//   "You cannot begin a transaction on a session with an open transaction"
//
// The fix: all reads are consolidated into ONE session.executeRead() callback.
// This test mocks the session to throw on a second executeRead() call and
// asserts the fixed code never triggers that error path.
// ---------------------------------------------------------------------------

describe("executeContextRetrieval — regression: single-transaction consolidation (Req 2.6)", () => {
  it("never calls session.executeRead() more than once per invocation", async () => {
    vi.mocked(graphQuery.txFindNode).mockResolvedValue(mockTargetNode);
    vi.mocked(graphQuery.txFindDependents).mockResolvedValue([mockCallerNode]);
    vi.mocked(graphQuery.txFindDependencies).mockResolvedValue([mockCalleeNode]);
    vi.mocked(graphQuery.txFindProcessesBySymbol).mockResolvedValue([mockProcessNode]);
    vi.mocked(graphQuery.txFindClustersBySymbol).mockResolvedValue([mockClusterNode]);
    vi.mocked(graphQuery.txFindProcessSteps).mockResolvedValue([]);

    const mockTx = {} as ManagedTransaction;
    let executeReadCallCount = 0;

    const session = {
      executeRead: vi.fn().mockImplementation((cb: (tx: ManagedTransaction) => Promise<unknown>) => {
        executeReadCallCount++;
        if (executeReadCallCount > 1) {
          // Simulate Neo4j driver v5+ error for second executeRead on same session
          throw new Error("You cannot begin a transaction on a session with an open transaction");
        }
        return cb(mockTx);
      }),
    } as unknown as Session;

    // Fixed code consolidates all reads into one executeRead — must not throw
    await expect(
      executeContextRetrieval("target-symbol-id", 10, session),
    ).resolves.toBeDefined();

    expect(executeReadCallCount).toBe(1);
  });

  it("executes all graph queries (node, dependents, dependencies, processes, clusters) within the single transaction", async () => {
    vi.mocked(graphQuery.txFindNode).mockResolvedValue(mockTargetNode);
    vi.mocked(graphQuery.txFindDependents).mockResolvedValue([]);
    vi.mocked(graphQuery.txFindDependencies).mockResolvedValue([]);
    vi.mocked(graphQuery.txFindProcessesBySymbol).mockResolvedValue([]);
    vi.mocked(graphQuery.txFindClustersBySymbol).mockResolvedValue([]);

    const capturedTxRefs: ManagedTransaction[] = [];
    const sharedTx = {} as ManagedTransaction;

    const session = {
      executeRead: vi.fn().mockImplementation((cb: (tx: ManagedTransaction) => Promise<unknown>) => {
        return cb(sharedTx);
      }),
    } as unknown as Session;

    // Capture the tx passed to each graph query function
    vi.mocked(graphQuery.txFindNode).mockImplementation(async (tx) => {
      capturedTxRefs.push(tx);
      return mockTargetNode;
    });
    vi.mocked(graphQuery.txFindDependents).mockImplementation(async (tx) => {
      capturedTxRefs.push(tx);
      return [];
    });
    vi.mocked(graphQuery.txFindDependencies).mockImplementation(async (tx) => {
      capturedTxRefs.push(tx);
      return [];
    });
    vi.mocked(graphQuery.txFindProcessesBySymbol).mockImplementation(async (tx) => {
      capturedTxRefs.push(tx);
      return [];
    });
    vi.mocked(graphQuery.txFindClustersBySymbol).mockImplementation(async (tx) => {
      capturedTxRefs.push(tx);
      return [];
    });

    await executeContextRetrieval("target-symbol-id", 10, session);

    // All 5 query functions must have received the same ManagedTransaction
    expect(capturedTxRefs.length).toBeGreaterThanOrEqual(5);
    expect(capturedTxRefs.every((tx) => tx === sharedTx)).toBe(true);

    // And executeRead was called exactly once
    expect(session.executeRead).toHaveBeenCalledTimes(1);
  });
});
