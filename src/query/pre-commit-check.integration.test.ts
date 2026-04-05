/**
 * Integration test for pre-commit check query.
 * Demonstrates the complete flow from changed files to risk assessment.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { executePreCommitCheck } from "./pre-commit-check.js";
import type { Session } from "neo4j-driver";
import type { GraphNode } from "../graph/connection.js";

// ─── Mock Setup ───────────────────────────────────────────────────────────────

function createMockSession(): Session {
  const runFn = vi.fn();
  return {
    run: runFn,
    executeRead: vi.fn(async (work: (tx: { run: typeof runFn }) => Promise<unknown>) => work({ run: runFn })),
    executeWrite: vi.fn(async (work: (tx: { run: typeof runFn }) => Promise<unknown>) => work({ run: runFn })),
  } as unknown as Session;
}

function createMockSymbolNode(id: string, name: string, filePath: string): GraphNode {
  return {
    id,
    labels: ["Symbol"],
    properties: {
      id,
      name,
      kind: "function",
      filePath,
      startLine: "1",
      startColumn: "0",
      endLine: "10",
      endColumn: "0",
      visibility: "public",
    },
  };
}

function createMockProcessNode(id: string, name: string): GraphNode {
  return {
    id,
    labels: ["Process"],
    properties: {
      id,
      name,
      entryPoint: "entry1",
    },
  };
}

// ─── Integration Tests ────────────────────────────────────────────────────────

describe("executePreCommitCheck - integration", () => {
  let mockSession: Session;

  beforeEach(() => {
    mockSession = createMockSession();
  });

  it("returns low risk when no symbols are found in changed files", async () => {
    vi.mocked(mockSession.run).mockResolvedValueOnce({
      records: [],
    } as never);

    const result = await executePreCommitCheck(
      ["src/utils/helper.ts"],
      10,
      mockSession,
    );

    expect(result.riskLevel).toBe("low");
    expect(result.confidence).toBe(0.95);
    expect(result.symbols).toHaveLength(0);
    expect(result.affectedFlows).toHaveLength(0);
  });

  it("identifies changed symbols and their dependents", async () => {
    const changedSymbol = createMockSymbolNode("s1", "getUserData", "src/user.ts");
    const dependent1 = createMockSymbolNode("s2", "processUser", "src/process.ts");
    const dependent2 = createMockSymbolNode("s3", "displayUser", "src/display.ts");

    // Mock: find symbols in changed files
    vi.mocked(mockSession.run).mockResolvedValueOnce({
      records: [{ get: () => changedSymbol }],
    } as never);

    // Mock: find dependents for s1
    vi.mocked(mockSession.run).mockResolvedValueOnce({
      records: [
        { toObject: () => ({ n: dependent1 }) },
        { toObject: () => ({ n: dependent2 }) },
      ],
    } as never);

    // Mock: find processes for s1
    vi.mocked(mockSession.run).mockResolvedValueOnce({
      records: [],
    } as never);

    // Mock: find processes for s2
    vi.mocked(mockSession.run).mockResolvedValueOnce({
      records: [],
    } as never);

    // Mock: find processes for s3
    vi.mocked(mockSession.run).mockResolvedValueOnce({
      records: [],
    } as never);

    // Mock: find clusters for s1
    vi.mocked(mockSession.run).mockResolvedValueOnce({
      records: [],
    } as never);

    const result = await executePreCommitCheck(
      ["src/user.ts"],
      10,
      mockSession,
    );

    expect(result.symbols.length).toBeGreaterThan(0);
    expect(result.riskLevel).toBe("medium"); // 3 symbols total
    expect(result.confidence).toBe(0.93);
  });

  it("identifies affected business processes", async () => {
    const changedSymbol = createMockSymbolNode("s1", "authService", "src/auth.ts");
    const process1 = createMockProcessNode("p1", "User Login Flow");
    const process2 = createMockProcessNode("p2", "User Registration Flow");

    // Mock: find symbols in changed files
    vi.mocked(mockSession.run).mockResolvedValueOnce({
      records: [{ get: () => changedSymbol }],
    } as never);

    // Mock: find dependents for s1
    vi.mocked(mockSession.run).mockResolvedValueOnce({
      records: [],
    } as never);

    // Mock: find processes for s1
    vi.mocked(mockSession.run).mockResolvedValueOnce({
      records: [
        { get: () => process1 },
        { get: () => process2 },
      ],
    } as never);

    // Mock: findProcessSteps for p1 (called by graphNodeToProcess)
    vi.mocked(mockSession.run).mockResolvedValueOnce({
      records: [],
    } as never);

    // Mock: findProcessSteps for p2 (called by graphNodeToProcess)
    vi.mocked(mockSession.run).mockResolvedValueOnce({
      records: [],
    } as never);

    // Mock: find clusters for s1
    vi.mocked(mockSession.run).mockResolvedValueOnce({
      records: [],
    } as never);

    const result = await executePreCommitCheck(
      ["src/auth.ts"],
      10,
      mockSession,
    );

    expect(result.riskLevel).toBe("critical"); // auth is a core component
    expect(result.processes).toHaveLength(2);
    expect(result.affectedFlows.length).toBeGreaterThan(0);
    expect(result.affectedFlows).toContain("User Login Flow");
    expect(result.affectedFlows).toContain("User Registration Flow");
  });

  it("generates appropriate test recommendations based on risk level", async () => {
    const changedSymbol = createMockSymbolNode("s1", "formatDate", "src/utils.ts");

    // Mock: find symbols in changed files
    vi.mocked(mockSession.run).mockResolvedValueOnce({
      records: [{ get: () => changedSymbol }],
    } as never);

    // Mock: find dependents for s1
    vi.mocked(mockSession.run).mockResolvedValueOnce({
      records: [],
    } as never);

    // Mock: find processes for s1
    vi.mocked(mockSession.run).mockResolvedValueOnce({
      records: [],
    } as never);

    // Mock: find clusters for s1
    vi.mocked(mockSession.run).mockResolvedValueOnce({
      records: [],
    } as never);

    const result = await executePreCommitCheck(
      ["src/utils.ts"],
      10,
      mockSession,
    );

    expect(result.riskLevel).toBe("low");
    expect(result.affectedFlows.some((rec) => rec.includes("unit tests"))).toBe(true);
  });
});
