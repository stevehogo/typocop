/**
 * Bug condition exploration tests for graphNodeToProcess.
 * Updated to use GraphAdapter instead of Neo4j Session.
 *
 * Requirements: 1.1, 1.2, 3.1, 3.2, 3.3, 3.4, 7.2
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
import type { GraphAdapter, GraphNode } from "../db/types.js";
import { executeContextRetrieval } from "./context-retrieval.js";
import { executeImpactAnalysis } from "./impact-analysis.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProcessNode(id: string, stepCount: number): GraphNode {
  return {
    id, labels: ["Process"],
    properties: { id, name: `Process_${id}`, entryPoint: `entry-${id}`, stepCount: String(stepCount) },
  };
}

function makeSymbolNode(id: string): GraphNode {
  return {
    id, labels: ["Symbol"],
    properties: {
      id, name: `Symbol_${id}`, kind: "function", filePath: `/src/${id}.ts`,
      startLine: "1", startColumn: "0", endLine: "10", endColumn: "0", visibility: "public",
    },
  };
}

function nodeRow(node: GraphNode): { n: { labels: readonly string[]; properties: Readonly<Record<string, unknown>> } } {
  return { n: { labels: node.labels, properties: node.properties } };
}

function processRow(node: GraphNode): { p: { labels: readonly string[]; properties: Readonly<Record<string, unknown>> } } {
  return { p: { labels: node.labels, properties: node.properties } };
}

/**
 * Build a mock GraphAdapter with sequenced runCypher responses.
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

// ─── Property 1: Bug Condition ────────────────────────────────────────────────

describe("Property 1 — Bug Condition: graphNodeToProcess steps (via GraphAdapter)", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("PBT: for any Process node with N steps (N ∈ [1,5]), returned steps.length === N", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        async (stepCount) => {
          const processNode = makeProcessNode(`proc-${stepCount}`, stepCount);
          const targetNode = makeSymbolNode("target-sym");
          const stepRecords = Array.from({ length: stepCount }, (_, i) => ({
            symbolId: `step-sym-${i}`, order: i, description: `Step ${i}`,
          }));

          const adapter = makeGraphAdapter([
            [nodeRow(targetNode)],       // 1. findNode
            [],                          // 2. findDependents
            [],                          // 3. findDependencies
            [processRow(processNode)],   // 4. findProcessesBySymbol
            stepRecords,                 // 5. findProcessSteps for process
            [],                          // 6. findClustersBySymbol
          ]);

          const result = await executeContextRetrieval("target-sym", 50, adapter);
          expect(result.processes[0].steps.length).toBe(stepCount);
        },
      ),
      { numRuns: 10 },
    );
  });

  it("concrete: Process with 3 HAS_STEP edges returns steps.length === 3", async () => {
    const processNode = makeProcessNode("proc-3", 3);
    const targetNode = makeSymbolNode("target-sym");
    const steps = [
      { symbolId: "s0", order: 0, description: "Step 0" },
      { symbolId: "s1", order: 1, description: "Step 1" },
      { symbolId: "s2", order: 2, description: "Step 2" },
    ];

    const adapter = makeGraphAdapter([
      [nodeRow(targetNode)], [], [], [processRow(processNode)], steps, [],
    ]);

    const result = await executeContextRetrieval("target-sym", 50, adapter);
    expect(result.processes[0].steps.length).toBe(3);
  });

  it("edge case: Process with 0 HAS_STEP edges returns steps.length === 0", async () => {
    const processNode = makeProcessNode("proc-0", 0);
    const targetNode = makeSymbolNode("target-sym");

    const adapter = makeGraphAdapter([
      [nodeRow(targetNode)], [], [], [processRow(processNode)], [], [],
    ]);

    const result = await executeContextRetrieval("target-sym", 50, adapter);
    expect(result.processes[0].steps.length).toBe(0);
  });
});

// ─── Property 2: Preservation ─────────────────────────────────────────────────

describe("Property 2 — Preservation: non-process fields unchanged (via GraphAdapter)", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("PBT: symbols array contains target regardless of step count", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.integer({ min: 0, max: 5 }),
        async (symbolName, stepCount) => {
          const targetNode = makeSymbolNode(symbolName);
          const processNode = makeProcessNode("proc-pres", stepCount);

          const adapter = makeGraphAdapter([
            [nodeRow(targetNode)], [], [], [processRow(processNode)], [], [],
          ]);

          const result = await executeContextRetrieval(symbolName, 50, adapter);
          expect(result.symbols.length).toBeGreaterThanOrEqual(1);
          expect(result.symbols[0].id).toBe(symbolName);
        },
      ),
      { numRuns: 10 },
    );
  });

  it("PBT: riskLevel is always 'low' for context retrieval", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }),
        async (stepCount) => {
          const targetNode = makeSymbolNode("target-sym");
          const processNode = makeProcessNode("proc-risk", stepCount);

          const adapter = makeGraphAdapter([
            [nodeRow(targetNode)], [], [], [processRow(processNode)], [], [],
          ]);

          const result = await executeContextRetrieval("target-sym", 50, adapter);
          expect(result.riskLevel).toBe("low");
        },
      ),
      { numRuns: 10 },
    );
  });

  it("confidence is 0.92 when process context is found", async () => {
    const targetNode = makeSymbolNode("target-sym");
    const processNode = makeProcessNode("proc-conf", 2);

    const adapter = makeGraphAdapter([
      [nodeRow(targetNode)], [], [], [processRow(processNode)], [], [],
    ]);

    const result = await executeContextRetrieval("target-sym", 50, adapter);
    expect(result.confidence).toBe(0.92);
  });
});

// ─── Property 2 (Impact Analysis): Preservation ───────────────────────────────

describe("Property 2 — Preservation (executeImpactAnalysis): via GraphAdapter", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("PBT: symbols array contains target + dependents", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.integer({ min: 0, max: 3 }),
        async (targetName, depCount) => {
          const targetNode = makeSymbolNode(targetName);
          const depNodes = Array.from({ length: depCount }, (_, i) =>
            nodeRow(makeSymbolNode(`dep-${targetName}-${i}`)),
          );
          const processNode = makeProcessNode("proc-ia", 0);

          const adapter = makeGraphAdapter([
            [nodeRow(targetNode)], depNodes, [processRow(processNode)], [], [],
          ]);

          const result = await executeImpactAnalysis(targetName, 50, adapter);
          expect(result.symbols.length).toBe(1 + depCount);
          expect(result.symbols[0].id).toBe(targetName);
        },
      ),
      { numRuns: 10 },
    );
  });

  it("affectedFlows lists process names", async () => {
    const targetNode = makeSymbolNode("target-ia");
    const processNode = makeProcessNode("proc-flow", 2);

    const adapter = makeGraphAdapter([
      [nodeRow(targetNode)], [], [processRow(processNode)], [], [],
    ]);

    const result = await executeImpactAnalysis("target-ia", 50, adapter);
    expect(result.affectedFlows).toEqual(["Process_proc-flow"]);
  });

  it("clusters are returned unchanged", async () => {
    const targetNode = makeSymbolNode("target-ia");
    const clusterNode: GraphNode = {
      id: "cluster-1", labels: ["Cluster"],
      properties: { id: "cluster-1", name: "Auth Cluster", confidence: "0.9", category: "authentication" },
    };
    const processNode = makeProcessNode("proc-cl", 3);

    const adapter = makeGraphAdapter([
      [nodeRow(targetNode)],                                                          // 1. findNode
      [],                                                                             // 2. findDependents
      [processRow(processNode)],                                                      // 3. findProcessesBySymbol
      [],                                                                             // 4. findProcessSteps for proc-cl
      [{ c: { labels: clusterNode.labels, properties: clusterNode.properties } }],    // 5. findClustersBySymbol
    ]);

    const result = await executeImpactAnalysis("target-ia", 50, adapter);
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0].id).toBe("cluster-1");
  });
});
