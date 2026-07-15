/**
 * Unit tests for context retrieval query logic.
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 7.2
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GraphAdapter, GraphNode } from "../../core/ports/persistence.js";
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
function nodeRow(node: GraphNode): { n: { labels: readonly string[]; properties: Readonly<Record<string, unknown>> } } {
  return { n: { labels: node.labels, properties: node.properties } };
}

function processRow(node: GraphNode): { p: { labels: readonly string[]; properties: Readonly<Record<string, unknown>> } } {
  return { p: { labels: node.labels, properties: node.properties } };
}

function clusterRow(node: GraphNode): { c: { labels: readonly string[]; properties: Readonly<Record<string, unknown>> } } {
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

  // ── Wave 8 (T6): heritage / MRO surfacing from persisted edges ────────────
  describe("heritage (T6)", () => {
    /**
     * Query-aware mock: branches on the heritage query fragments so the BFS over
     * INHERITS, the IMPLEMENTS lookup, and the OVERRIDES|METHODIMPLEMENTS lookup
     * are answered deterministically (the sequenced mock can't express the BFS).
     */
    function heritageGraph(opts: {
      inherits: Record<string, Array<{ id: string; name: string }>>;
      implements?: Array<{ id: string; name: string }>;
      overrides?: Array<{ id: string; name: string; type: "OVERRIDES" | "METHODIMPLEMENTS" }>;
    }): GraphAdapter {
      const runCypher = async <T,>(query: string, params?: Record<string, unknown>): Promise<T[]> => {
        const val = params?.["val"] as string | undefined;
        if (query.includes("[:INHERITS]->")) {
          const sups = (val && opts.inherits[val]) || [];
          return sups.map((s) => ({ superId: s.id, superName: s.name })) as unknown as T[];
        }
        if (query.includes("[:IMPLEMENTS]->")) {
          return (opts.implements ?? []).map((s) => ({ superId: s.id, superName: s.name })) as unknown as T[];
        }
        if (query.includes("OVERRIDES|METHODIMPLEMENTS")) {
          return (opts.overrides ?? []).map((o) => ({ targetId: o.id, targetName: o.name, edgeType: o.type })) as unknown as T[];
        }
        // Resolver exact lookup for the target.
        if (query.includes("WHERE n.id = $val") && query.includes("LIMIT 1")) {
          return [nodeRow(mockTargetNode)] as unknown as T[];
        }
        return [] as T[];
      };
      return {
        createNode: vi.fn(),
        createRelationship: vi.fn(),
        queryNodes: vi.fn(),
        queryRelationships: vi.fn(),
        deleteNodesByLabel: vi.fn(),
        deleteRelationshipsByType: vi.fn(),
        runCypher: runCypher as GraphAdapter["runCypher"],
        runCypherWrite: vi.fn(),
      };
    }

    it("walks the INHERITS chain nearest-first with hop depth", async () => {
      const adapter = heritageGraph({
        inherits: {
          "target-symbol-id": [{ id: "base1", name: "Base" }],
          base1: [{ id: "base2", name: "GrandBase" }],
        },
      });
      const result = await executeContextRetrieval("target-symbol-id", 10, adapter);
      expect(result.heritage?.ancestors).toEqual([
        { id: "base1", name: "Base", depth: 1 },
        { id: "base2", name: "GrandBase", depth: 2 },
      ]);
    });

    it("surfaces implemented interfaces and override/methodImplements edges", async () => {
      const adapter = heritageGraph({
        inherits: {},
        implements: [{ id: "iface1", name: "Comparable" }],
        overrides: [
          { id: "Base.compute", name: "compute", type: "OVERRIDES" },
          { id: "Comparable.compareTo", name: "compareTo", type: "METHODIMPLEMENTS" },
        ],
      });
      const result = await executeContextRetrieval("target-symbol-id", 10, adapter);
      expect(result.heritage?.interfaces).toEqual([{ id: "iface1", name: "Comparable" }]);
      expect(result.heritage?.overrides).toEqual([
        { id: "Base.compute", name: "compute", relation: "overrides" },
        { id: "Comparable.compareTo", name: "compareTo", relation: "methodImplements" },
      ]);
    });

    it("returns empty heritage arrays for a symbol with no heritage edges (degrade)", async () => {
      const adapter = heritageGraph({ inherits: {} });
      const result = await executeContextRetrieval("target-symbol-id", 10, adapter);
      expect(result.heritage).toEqual({ ancestors: [], interfaces: [], overrides: [] });
    });
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
