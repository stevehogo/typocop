/**
 * Unit tests for context retrieval query logic.
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "neo4j-driver";
import { executeContextRetrieval } from "./context-retrieval.js";
import * as graphQuery from "../graph/query.js";
import type { GraphNode } from "../graph/connection.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../graph/query.js", () => ({
  findNode: vi.fn(),
  findDependents: vi.fn(),
  findDependencies: vi.fn(),
  findProcessesBySymbol: vi.fn(),
  findClustersBySymbol: vi.fn(),
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("executeContextRetrieval", () => {
  let mockSession: Session;

  beforeEach(() => {
    mockSession = {} as Session;
    vi.clearAllMocks();
  });

  /**
   * Req 12.1: Identify target symbol
   */
  it("returns empty result when target symbol not found", async () => {
    vi.mocked(graphQuery.findNode).mockResolvedValue(null);

    const result = await executeContextRetrieval("nonexistent-id", 10, mockSession);

    expect(result.symbols).toEqual([]);
    expect(result.relationships).toEqual([]);
    expect(result.clusters).toEqual([]);
    expect(result.processes).toEqual([]);
    expect(result.confidence).toBe(0.5);
    expect(result.riskLevel).toBe("low");
  });

  /**
   * Req 12.2: Find all callers using findDependents
   */
  it("finds all callers of the target symbol", async () => {
    vi.mocked(graphQuery.findNode).mockResolvedValue(mockTargetNode);
    vi.mocked(graphQuery.findDependents).mockResolvedValue([mockCallerNode]);
    vi.mocked(graphQuery.findDependencies).mockResolvedValue([]);
    vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([]);
    vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([]);

    const result = await executeContextRetrieval("target-symbol-id", 10, mockSession);

    expect(graphQuery.findDependents).toHaveBeenCalledWith(mockSession, "target-symbol-id");
    expect(result.symbols).toHaveLength(2); // target + caller
    expect(result.symbols.some((s) => s.id === "caller-symbol-id")).toBe(true);
    expect(result.relationships.some((r) => r.source === "caller-symbol-id" && r.target === "target-symbol-id")).toBe(true);
  });

  /**
   * Req 12.3: Find all callees using findDependencies
   */
  it("finds all callees of the target symbol", async () => {
    vi.mocked(graphQuery.findNode).mockResolvedValue(mockTargetNode);
    vi.mocked(graphQuery.findDependents).mockResolvedValue([]);
    vi.mocked(graphQuery.findDependencies).mockResolvedValue([mockCalleeNode]);
    vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([]);
    vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([]);

    const result = await executeContextRetrieval("target-symbol-id", 10, mockSession);

    expect(graphQuery.findDependencies).toHaveBeenCalledWith(mockSession, "target-symbol-id");
    expect(result.symbols).toHaveLength(2); // target + callee
    expect(result.symbols.some((s) => s.id === "callee-symbol-id")).toBe(true);
    expect(result.relationships.some((r) => r.source === "target-symbol-id" && r.target === "callee-symbol-id")).toBe(true);
  });

  /**
   * Req 12.4: Find all processes containing the symbol
   */
  it("finds all processes containing the target symbol", async () => {
    vi.mocked(graphQuery.findNode).mockResolvedValue(mockTargetNode);
    vi.mocked(graphQuery.findDependents).mockResolvedValue([]);
    vi.mocked(graphQuery.findDependencies).mockResolvedValue([]);
    vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([mockProcessNode]);
    vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([]);

    const result = await executeContextRetrieval("target-symbol-id", 10, mockSession);

    expect(graphQuery.findProcessesBySymbol).toHaveBeenCalledWith(mockSession, "target-symbol-id");
    expect(result.processes).toHaveLength(1);
    expect(result.processes[0].id).toBe("process-id");
    expect(result.processes[0].name).toBe("UserRegistrationFlow");
    expect(result.affectedFlows).toContain("UserRegistrationFlow");
  });

  /**
   * Req 12.5: Find all clusters containing the symbol
   */
  it("finds all clusters containing the target symbol", async () => {
    vi.mocked(graphQuery.findNode).mockResolvedValue(mockTargetNode);
    vi.mocked(graphQuery.findDependents).mockResolvedValue([]);
    vi.mocked(graphQuery.findDependencies).mockResolvedValue([]);
    vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([]);
    vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([mockClusterNode]);

    const result = await executeContextRetrieval("target-symbol-id", 10, mockSession);

    expect(graphQuery.findClustersBySymbol).toHaveBeenCalledWith(mockSession, "target-symbol-id");
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].id).toBe("cluster-id");
    expect(result.clusters[0].name).toBe("AuthenticationCluster");
    expect(result.clusters[0].category).toBe("authentication");
  });

  /**
   * Req 12.6: Return complete 360° context
   */
  it("returns complete 360° context with all relationships", async () => {
    vi.mocked(graphQuery.findNode).mockResolvedValue(mockTargetNode);
    vi.mocked(graphQuery.findDependents).mockResolvedValue([mockCallerNode]);
    vi.mocked(graphQuery.findDependencies).mockResolvedValue([mockCalleeNode]);
    vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([mockProcessNode]);
    vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([mockClusterNode]);

    const result = await executeContextRetrieval("target-symbol-id", 10, mockSession);

    // Verify all components are present
    expect(result.symbols).toHaveLength(3); // target + caller + callee
    expect(result.relationships).toHaveLength(2); // caller->target, target->callee
    expect(result.clusters).toHaveLength(1);
    expect(result.processes).toHaveLength(1);
    
    // Verify high confidence when context is found
    expect(result.confidence).toBe(0.92);
    expect(result.riskLevel).toBe("low");
    
    // Verify affected flows
    expect(result.affectedFlows).toContain("UserRegistrationFlow");
  });

  /**
   * Confidence scoring: high when context found, medium when only target found
   */
  it("returns lower confidence when no context is found", async () => {
    vi.mocked(graphQuery.findNode).mockResolvedValue(mockTargetNode);
    vi.mocked(graphQuery.findDependents).mockResolvedValue([]);
    vi.mocked(graphQuery.findDependencies).mockResolvedValue([]);
    vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([]);
    vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([]);

    const result = await executeContextRetrieval("target-symbol-id", 10, mockSession);

    expect(result.symbols).toHaveLength(1); // only target
    expect(result.confidence).toBe(0.75); // lower confidence
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

    vi.mocked(graphQuery.findNode).mockResolvedValue(mockTargetNode);
    vi.mocked(graphQuery.findDependents).mockResolvedValue(manyCallers);
    vi.mocked(graphQuery.findDependencies).mockResolvedValue([]);
    vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([]);
    vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([]);

    const result = await executeContextRetrieval("target-symbol-id", 5, mockSession);

    expect(result.symbols.length).toBeLessThanOrEqual(5);
  });
});
