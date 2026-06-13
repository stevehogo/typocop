/**
 * Unit tests for context retrieval query logic.
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 7.2
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GraphAdapter, GraphNode } from "../db/types.js";
import { executeContextRetrieval } from "./context-retrieval.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGraphNode(id: string, props: Record<string, string>): GraphNode {
  return { id, labels: ["Symbol"], properties: { id, ...props } };
}

const mockTargetNode: GraphNode = makeGraphNode("target-symbol-id", {
  name: "targetFunction", kind: "function", filePath: "/src/target.ts",
  startLine: "10", startColumn: "0", endLine: "20", endColumn: "0", visibility: "public",
});

const mockCallerNode: GraphNode = makeGraphNode("caller-symbol-id", {
  name: "callerFunction", kind: "function", filePath: "/src/caller.ts",
  startLine: "5", startColumn: "0", endLine: "15", endColumn: "0", visibility: "public",
});

const mockCalleeNode: GraphNode = makeGraphNode("callee-symbol-id", {
  name: "calleeFunction", kind: "function", filePath: "/src/callee.ts",
  startLine: "30", startColumn: "0", endLine: "40", endColumn: "0", visibility: "public",
});

const mockProcessNode: GraphNode = {
  id: "process-id", labels: ["Process"],
  properties: { id: "process-id", name: "UserRegistrationFlow", entryPoint: "target-symbol-id" },
};

const mockClusterNode: GraphNode = {
  id: "cluster-id", labels: ["Cluster"],
  properties: { id: "cluster-id", name: "AuthenticationCluster", confidence: "0.92", category: "authentication" },
};

const mockExternalDependencyNode: GraphNode = {
  id: "ext:lodash", labels: ["ExternalDependency"],
  properties: { id: "ext:lodash", name: "lodash", aliases: "lodash,Lodash", ecosystem: "npm" },
};

/**
 * Build a mock GraphAdapter with a sequenced runCypher that returns
 * different results for each call in order.
 */
function makeGraphAdapter(responses: unknown[][]): GraphAdapter {
  let callIndex = 0;
  return {
    createNode: vi.fn(),
    createRelationship: vi.fn(),
    queryNodes: vi.fn(),
    queryRelationships: vi.fn(),
    deleteNodesByLabel: vi.fn(),
    deleteRelationshipsByType: vi.fn(),
    runCypher: vi.fn().mockImplementation(() => {
      const result = responses[callIndex] ?? [];
      callIndex++;
      return Promise.resolve(result);
    }),
    runCypherWrite: vi.fn(),
  };
}

// Wrap a GraphNode in the Cypher row format returned by runCypher
function nodeRow(node: GraphNode): { n: { labels: string[]; properties: Record<string, string> } } {
  return { n: { labels: node.labels, properties: node.properties } };
}

function processRow(node: GraphNode): { p: { labels: string[]; properties: Record<string, string> } } {
  return { p: { labels: node.labels, properties: node.properties } };
}

function clusterRow(node: GraphNode): { c: { labels: string[]; properties: Record<string, string> } } {
  return { c: { labels: node.labels, properties: node.properties } };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("executeContextRetrieval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Req 12.1: Identify target symbol */
  it("returns empty result when target symbol not found", async () => {
    const adapter = makeGraphAdapter([[]]);
    const result = await executeContextRetrieval("nonexistent-id", 10, adapter);

    expect(result.symbols).toEqual([]);
    expect(result.relationships).toEqual([]);
    expect(result.confidence).toBe(0.5);
    expect(result.riskLevel).toBe("low");
  });

  /** Req 12.2: Find all callers */
  it("finds all callers of the target symbol", async () => {
    const adapter = makeGraphAdapter([
      [nodeRow(mockTargetNode)],   // findNode
      [nodeRow(mockCallerNode)],   // findDependents
      [],                          // findDependencies
      [],                          // findProcessesBySymbol
      [],                          // findClustersBySymbol
    ]);

    const result = await executeContextRetrieval("target-symbol-id", 10, adapter);

    expect(result.symbols).toHaveLength(2);
    expect(result.symbols.some((s) => s.id === "caller-symbol-id")).toBe(true);
    expect(result.relationships.some((r) => r.source === "caller-symbol-id")).toBe(true);
  });

  /** Req 12.3: Find all callees */
  it("finds all callees of the target symbol", async () => {
    const adapter = makeGraphAdapter([
      [nodeRow(mockTargetNode)],
      [],                          // findDependents
      [nodeRow(mockCalleeNode)],   // findDependencies
      [],
      [],
    ]);

    const result = await executeContextRetrieval("target-symbol-id", 10, adapter);

    expect(result.symbols).toHaveLength(2);
    expect(result.symbols.some((s) => s.id === "callee-symbol-id")).toBe(true);
  });

  /** Req 12.4: Find processes */
  it("finds all processes containing the target symbol", async () => {
    const adapter = makeGraphAdapter([
      [nodeRow(mockTargetNode)],
      [],
      [],
      [processRow(mockProcessNode)],
      [],
      [],  // findProcessSteps
    ]);

    const result = await executeContextRetrieval("target-symbol-id", 10, adapter);

    expect(result.processes).toHaveLength(1);
    expect(result.processes[0].name).toBe("UserRegistrationFlow");
  });

  /** Req 12.5: Find clusters */
  it("finds all clusters containing the target symbol", async () => {
    const adapter = makeGraphAdapter([
      [nodeRow(mockTargetNode)],
      [],
      [],
      [],
      [clusterRow(mockClusterNode)],
    ]);

    const result = await executeContextRetrieval("target-symbol-id", 10, adapter);

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].name).toBe("AuthenticationCluster");
    expect(result.clusters[0].category).toBe("authentication");
  });

  /** Req 12.6: Complete 360° context */
  it("returns complete 360° context with all relationships", async () => {
    const adapter = makeGraphAdapter([
      [nodeRow(mockTargetNode)],       // 1. findNode
      [nodeRow(mockCallerNode)],       // 2. findDependents
      [nodeRow(mockCalleeNode)],       // 3. findDependencies
      [processRow(mockProcessNode)],   // 4. findProcessesBySymbol
      [],                              // 5. findProcessSteps for process-id
      [clusterRow(mockClusterNode)],   // 6. findClustersBySymbol
      [{ ext: { labels: mockExternalDependencyNode.labels, properties: mockExternalDependencyNode.properties as Record<string, string> } }],
    ]);

    const result = await executeContextRetrieval("target-symbol-id", 10, adapter);

    expect(result.symbols).toHaveLength(3);
    expect(result.relationships).toHaveLength(3);
    expect(result.clusters).toHaveLength(1);
    expect(result.processes).toHaveLength(1);
    expect(result.confidence).toBe(0.92);
    expect(result.relationships.some((relationship) =>
      relationship.relType === "dependsOn" &&
      relationship.metadata["packageName"] === "lodash",
    )).toBe(true);
  });

  it("returns lower confidence when no context is found", async () => {
    const adapter = makeGraphAdapter([
      [nodeRow(mockTargetNode)],
      [], [], [], [],
    ]);

    const result = await executeContextRetrieval("target-symbol-id", 10, adapter);

    expect(result.symbols).toHaveLength(1);
    expect(result.confidence).toBe(0.75);
  });

  it("respects maxResults limit for symbols", async () => {
    const manyCallers = Array.from({ length: 10 }, (_, i) =>
      nodeRow(makeGraphNode(`caller-${i}`, {
        name: `caller${i}`, kind: "function", filePath: `/src/c${i}.ts`,
        startLine: "5", startColumn: "0", endLine: "15", endColumn: "0", visibility: "public",
      })),
    );

    const adapter = makeGraphAdapter([
      [nodeRow(mockTargetNode)],
      manyCallers,
      [], [], [],
    ]);

    const result = await executeContextRetrieval("target-symbol-id", 5, adapter);

    expect(result.symbols.length).toBeLessThanOrEqual(5);
  });
});
