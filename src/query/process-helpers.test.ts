/**
 * Bug condition exploration tests for graphNodeToProcess.
 *
 * Property 1 (Bug Condition): graphNodeToProcess always returns steps: []
 * regardless of HAS_STEP edges in Neo4j — this test MUST FAIL on unfixed code.
 *
 * Property 2 (Preservation): Non-process fields (symbols, clusters, confidence,
 * riskLevel, affectedFlows) are unchanged by the fix — these PASS on unfixed code.
 *
 * Requirements: 1.1, 1.2, 3.1, 3.2, 3.3, 3.4
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
import type { Session } from "neo4j-driver";
import { executeContextRetrieval } from "./context-retrieval.js";
import { executeImpactAnalysis } from "./impact-analysis.js";
import * as graphQuery from "../graph/query.js";
import type { GraphNode } from "../graph/connection.js";

// ─── Module mock ─────────────────────────────────────────────────────────────

vi.mock("../graph/query.js", () => ({
  findNode: vi.fn(),
  findDependents: vi.fn(),
  findDependencies: vi.fn(),
  findProcessesBySymbol: vi.fn(),
  findClustersBySymbol: vi.fn(),
  findProcessSteps: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProcessNode(id: string, stepCount: number): GraphNode {
  return {
    id,
    labels: ["Process"],
    properties: {
      id,
      name: `Process_${id}`,
      entryPoint: `entry-${id}`,
      stepCount: String(stepCount),
    },
  };
}

function makeSymbolNode(id: string): GraphNode {
  return {
    id,
    labels: ["Symbol"],
    properties: {
      id,
      name: `Symbol_${id}`,
      kind: "function",
      filePath: `/src/${id}.ts`,
      startLine: "1",
      startColumn: "0",
      endLine: "10",
      endColumn: "0",
      visibility: "public",
    },
  };
}

/**
 * Build a mock Neo4j session that would return HAS_STEP records for a given
 * process ID if queried. The current graphNodeToProcess never calls session.run,
 * so this mock is never actually invoked — which is exactly the bug.
 */
function makeSessionWithSteps(
  processId: string,
  steps: Array<{ symbolId: string; order: number; description: string }>,
): Session {
  const records = steps.map((s) => ({
    get: (key: string) => {
      if (key === "symbolId") return s.symbolId;
      if (key === "order") return s.order;
      if (key === "description") return s.description;
      return null;
    },
  }));

  return {
    run: vi.fn().mockResolvedValue({ records }),
  } as unknown as Session;
}

// ─── Property 1: Bug Condition ────────────────────────────────────────────────
// These tests MUST FAIL on unfixed code.
// Failure confirms graphNodeToProcess never queries HAS_STEP edges.

describe("Property 1 — Bug Condition: graphNodeToProcess steps always empty (MUST FAIL on unfixed code)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PBT: for any Process node with N steps (N ∈ [1,5]), returned steps.length === N", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        async (stepCount) => {
          const processId = `proc-${stepCount}`;
          const processNode = makeProcessNode(processId, stepCount);
          const targetNode = makeSymbolNode("target-sym");

          // Build step records findProcessSteps would return for this process
          const stepRecords = Array.from({ length: stepCount }, (_, i) => ({
            symbolId: `step-sym-${i}`,
            order: i,
            description: `Step ${i}`,
          }));

          const session = makeSessionWithSteps(processId, stepRecords);

          vi.mocked(graphQuery.findNode).mockResolvedValue(targetNode);
          vi.mocked(graphQuery.findDependents).mockResolvedValue([]);
          vi.mocked(graphQuery.findDependencies).mockResolvedValue([]);
          vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([processNode]);
          vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([]);
          vi.mocked(graphQuery.findProcessSteps).mockResolvedValue(stepRecords);

          const result = await executeContextRetrieval("target-sym", 50, session);

          // This assertion FAILS on unfixed code — steps is always []
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
    const session = makeSessionWithSteps("proc-3", steps);

    vi.mocked(graphQuery.findNode).mockResolvedValue(targetNode);
    vi.mocked(graphQuery.findDependents).mockResolvedValue([]);
    vi.mocked(graphQuery.findDependencies).mockResolvedValue([]);
    vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([processNode]);
    vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([]);
    vi.mocked(graphQuery.findProcessSteps).mockResolvedValue(steps);

    const result = await executeContextRetrieval("target-sym", 50, session);

    // COUNTEREXAMPLE: graphNodeToProcess(processNode) returns steps: []
    // when 3 HAS_STEP edges exist in the mocked session.
    expect(result.processes[0].steps.length).toBe(3);
  });

  it("concrete: steps are ordered ascending by order property", async () => {
    const processNode = makeProcessNode("proc-ord", 3);
    const targetNode = makeSymbolNode("target-sym");
    // Provide steps out-of-order to verify sorting
    const stepsOutOfOrder = [
      { symbolId: "s2", order: 2, description: "Step 2" },
      { symbolId: "s0", order: 0, description: "Step 0" },
      { symbolId: "s1", order: 1, description: "Step 1" },
    ];
    const stepsOrdered = [
      { symbolId: "s0", order: 0, description: "Step 0" },
      { symbolId: "s1", order: 1, description: "Step 1" },
      { symbolId: "s2", order: 2, description: "Step 2" },
    ];
    const session = makeSessionWithSteps("proc-ord", stepsOutOfOrder);

    vi.mocked(graphQuery.findNode).mockResolvedValue(targetNode);
    vi.mocked(graphQuery.findDependents).mockResolvedValue([]);
    vi.mocked(graphQuery.findDependencies).mockResolvedValue([]);
    vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([processNode]);
    vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([]);
    // findProcessSteps returns already-ordered results (Cypher ORDER BY r.order ASC)
    vi.mocked(graphQuery.findProcessSteps).mockResolvedValue(stepsOrdered);

    const result = await executeContextRetrieval("target-sym", 50, session);

    const steps = result.processes[0].steps;
    // FAILS on unfixed code — steps is [] so no ordering to check
    expect(steps.length).toBe(3);
    for (let i = 0; i < steps.length; i++) {
      expect(steps[i].order).toBe(i);
    }
  });

  it("edge case: Process with 0 HAS_STEP edges returns steps.length === 0 (passes on both versions)", async () => {
    const processNode = makeProcessNode("proc-0", 0);
    const targetNode = makeSymbolNode("target-sym");
    const session = makeSessionWithSteps("proc-0", []);

    vi.mocked(graphQuery.findNode).mockResolvedValue(targetNode);
    vi.mocked(graphQuery.findDependents).mockResolvedValue([]);
    vi.mocked(graphQuery.findDependencies).mockResolvedValue([]);
    vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([processNode]);
    vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([]);
    vi.mocked(graphQuery.findProcessSteps).mockResolvedValue([]);

    const result = await executeContextRetrieval("target-sym", 50, session);

    expect(result.processes[0].steps.length).toBe(0);
  });
});

// ─── Property 2: Preservation ─────────────────────────────────────────────────
// These tests PASS on unfixed code — they establish the baseline to preserve.

describe("Property 2 — Preservation: non-process fields unchanged (MUST PASS on unfixed code)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PBT: symbols array is identical regardless of step count in process", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.integer({ min: 0, max: 5 }),
        async (symbolName, stepCount) => {
          const targetNode: GraphNode = {
            id: symbolName,
            labels: ["Symbol"],
            properties: {
              id: symbolName,
              name: symbolName,
              kind: "function",
              filePath: `/src/${symbolName}.ts`,
              startLine: "1",
              startColumn: "0",
              endLine: "5",
              endColumn: "0",
              visibility: "public",
            },
          };
          const processNode = makeProcessNode("proc-pres", stepCount);
          const session = makeSessionWithSteps(
            "proc-pres",
            Array.from({ length: stepCount }, (_, i) => ({
              symbolId: `s${i}`,
              order: i,
              description: `Step ${i}`,
            })),
          );

          vi.mocked(graphQuery.findNode).mockResolvedValue(targetNode);
          vi.mocked(graphQuery.findDependents).mockResolvedValue([]);
          vi.mocked(graphQuery.findDependencies).mockResolvedValue([]);
          vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([processNode]);
          vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([]);
          vi.mocked(graphQuery.findProcessSteps).mockResolvedValue([]);

          const result = await executeContextRetrieval(symbolName, 50, session);

          // symbols must always contain the target symbol
          expect(result.symbols.length).toBeGreaterThanOrEqual(1);
          expect(result.symbols[0].id).toBe(symbolName);
        },
      ),
      { numRuns: 10 },
    );
  });

  it("PBT: riskLevel is always 'low' for context retrieval regardless of process steps", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }),
        async (stepCount) => {
          const targetNode = makeSymbolNode("target-sym");
          const processNode = makeProcessNode("proc-risk", stepCount);
          const session = makeSessionWithSteps("proc-risk", []);

          vi.mocked(graphQuery.findNode).mockResolvedValue(targetNode);
          vi.mocked(graphQuery.findDependents).mockResolvedValue([]);
          vi.mocked(graphQuery.findDependencies).mockResolvedValue([]);
          vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([processNode]);
          vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([]);
          vi.mocked(graphQuery.findProcessSteps).mockResolvedValue([]);

          const result = await executeContextRetrieval("target-sym", 50, session);

          expect(result.riskLevel).toBe("low");
        },
      ),
      { numRuns: 10 },
    );
  });

  it("PBT: processes is [] when findProcessesBySymbol returns no nodes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        async (symbolName) => {
          const targetNode = makeSymbolNode(symbolName);
          const session = {} as Session;

          vi.mocked(graphQuery.findNode).mockResolvedValue(targetNode);
          vi.mocked(graphQuery.findDependents).mockResolvedValue([]);
          vi.mocked(graphQuery.findDependencies).mockResolvedValue([]);
          vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([]);
          vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([]);

          const result = await executeContextRetrieval(symbolName, 50, session);

          expect(result.processes).toEqual([]);
        },
      ),
      { numRuns: 10 },
    );
  });

  it("confidence is 0.92 when process context is found (unchanged by fix)", async () => {
    const targetNode = makeSymbolNode("target-sym");
    const processNode = makeProcessNode("proc-conf", 2);
    const session = makeSessionWithSteps("proc-conf", []);

    vi.mocked(graphQuery.findNode).mockResolvedValue(targetNode);
    vi.mocked(graphQuery.findDependents).mockResolvedValue([]);
    vi.mocked(graphQuery.findDependencies).mockResolvedValue([]);
    vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([processNode]);
    vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([]);
    vi.mocked(graphQuery.findProcessSteps).mockResolvedValue([]);

    const result = await executeContextRetrieval("target-sym", 50, session);

    expect(result.confidence).toBe(0.92);
  });
});

// ─── Property 2 (Impact Analysis): Preservation ───────────────────────────────
// Verify executeImpactAnalysis non-process fields are identical before/after fix.
// These tests PASS on unfixed code.

describe("Property 2 — Preservation (executeImpactAnalysis): non-process fields unchanged (MUST PASS on unfixed code)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PBT: symbols array contains target + dependents regardless of process step count", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 5 }),
        async (targetName, depCount, stepCount) => {
          const targetNode = makeSymbolNode(targetName);
          const depNodes = Array.from({ length: depCount }, (_, i) =>
            makeSymbolNode(`dep-${targetName}-${i}`),
          );
          const processNode = makeProcessNode("proc-ia", stepCount);
          const session = makeSessionWithSteps("proc-ia", []);

          vi.mocked(graphQuery.findNode).mockResolvedValue(targetNode);
          vi.mocked(graphQuery.findDependents).mockResolvedValue(depNodes);
          vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([processNode]);
          vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([]);
          vi.mocked(graphQuery.findProcessSteps).mockResolvedValue([]);

          const result = await executeImpactAnalysis(targetName, 50, session);

          // symbols = [target, ...dependents] — unchanged by fix
          expect(result.symbols.length).toBe(1 + depCount);
          expect(result.symbols[0].id).toBe(targetName);
        },
      ),
      { numRuns: 10 },
    );
  });

  it("PBT: riskLevel is determined by dependent count, not process steps", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }),
        async (stepCount) => {
          const targetNode = makeSymbolNode("target-ia");
          // 2 dependents → riskLevel "low" (count < 3)
          const depNodes = [makeSymbolNode("dep-a"), makeSymbolNode("dep-b")];
          const processNode = makeProcessNode("proc-risk-ia", stepCount);
          const session = makeSessionWithSteps("proc-risk-ia", []);

          vi.mocked(graphQuery.findNode).mockResolvedValue(targetNode);
          vi.mocked(graphQuery.findDependents).mockResolvedValue(depNodes);
          vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([processNode]);
          vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([]);
          vi.mocked(graphQuery.findProcessSteps).mockResolvedValue([]);

          const result = await executeImpactAnalysis("target-ia", 50, session);

          // riskLevel depends only on dependent count — unchanged by fix
          expect(result.riskLevel).toBe("low");
        },
      ),
      { numRuns: 10 },
    );
  });

  it("PBT: processes is [] when findProcessesBySymbol returns no nodes (impact analysis)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        async (targetName) => {
          const targetNode = makeSymbolNode(targetName);
          const session = {} as Session;

          vi.mocked(graphQuery.findNode).mockResolvedValue(targetNode);
          vi.mocked(graphQuery.findDependents).mockResolvedValue([]);
          vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([]);
          vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([]);

          const result = await executeImpactAnalysis(targetName, 50, session);

          // Req 3.4 — processes: [] when no processes found
          expect(result.processes).toEqual([]);
        },
      ),
      { numRuns: 10 },
    );
  });

  it("affectedFlows lists process names (unchanged by fix)", async () => {
    const targetNode = makeSymbolNode("target-ia");
    const processNode = makeProcessNode("proc-flow", 2);
    const session = makeSessionWithSteps("proc-flow", []);

    vi.mocked(graphQuery.findNode).mockResolvedValue(targetNode);
    vi.mocked(graphQuery.findDependents).mockResolvedValue([]);
    vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([processNode]);
    vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([]);
    vi.mocked(graphQuery.findProcessSteps).mockResolvedValue([]);

    const result = await executeImpactAnalysis("target-ia", 50, session);

    // affectedFlows = process names — unchanged by fix
    expect(result.affectedFlows).toEqual(["Process_proc-flow"]);
  });

  it("clusters are returned unchanged regardless of process step count", async () => {
    const targetNode = makeSymbolNode("target-ia");
    const clusterNode: GraphNode = {
      id: "cluster-1",
      labels: ["Cluster"],
      properties: { id: "cluster-1", name: "Auth Cluster", confidence: "0.9", category: "authentication" },
    };
    const processNode = makeProcessNode("proc-cl", 3);
    const session = makeSessionWithSteps("proc-cl", []);

    vi.mocked(graphQuery.findNode).mockResolvedValue(targetNode);
    vi.mocked(graphQuery.findDependents).mockResolvedValue([]);
    vi.mocked(graphQuery.findProcessesBySymbol).mockResolvedValue([processNode]);
    vi.mocked(graphQuery.findClustersBySymbol).mockResolvedValue([clusterNode]);
    vi.mocked(graphQuery.findProcessSteps).mockResolvedValue([]);

    const result = await executeImpactAnalysis("target-ia", 50, session);

    // clusters are independent of process steps — unchanged by fix
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0].id).toBe("cluster-1");
    expect(result.clusters[0].confidence).toBe(0.9);
  });
});
