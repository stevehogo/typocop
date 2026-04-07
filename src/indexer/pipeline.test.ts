/**
 * Bug condition exploration tests for cluster/process edge direction and relType.
 *
 * Property 1 (Bug Condition): Reversed Edge Direction and Wrong RelType
 *
 * These tests encode the EXPECTED (correct) behavior.
 * They MUST FAIL on unfixed code — failure confirms the bug exists.
 * They will PASS after the fix in task 3.
 *
 * Requirements: 1.1, 1.2
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
import type { Cluster, Process, ProcessStep } from "../types/index.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Capture edges emitted by storeInDatabases without a real Neo4j session
const mockStoreNodes = vi.fn().mockResolvedValue(undefined);
const mockStoreEdges = vi.fn().mockResolvedValue(undefined);

vi.mock("../graph/store.js", () => ({
  storeNodes: (...args: unknown[]) => mockStoreNodes(...args),
  storeEdges: (...args: unknown[]) => mockStoreEdges(...args),
}));

// Stub out all pipeline phases — we only care about storeInDatabases edge output
vi.mock("./structure/index.js", () => ({
  walkFileTree: vi.fn().mockResolvedValue([{ path: "src/stub.ts", size: 100 }]),
  readFileContents: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("./parsing/index.js", () => ({
  extractAllSymbols: vi.fn().mockResolvedValue({ symbols: [], hints: [] }),
}));

vi.mock("./resolution/index.js", () => ({
  resolveReferences: vi.fn().mockReturnValue([]),
}));

vi.mock("./clustering/index.js", () => ({
  clusterSymbols: vi.fn(),
}));

vi.mock("./processes/index.js", () => ({
  traceProcesses: vi.fn(),
}));

vi.mock("./search/index.js", () => ({
  buildSearchIndex: vi.fn().mockResolvedValue({ keywords: new Map(), symbolCount: 0, embeddings: [] }),
}));

vi.mock("../vector/index-store.js", () => ({
  indexSymbol: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config/index.js", () => ({
  configurationManager: {
    initialize: vi.fn().mockResolvedValue(undefined),
    getPrefix: vi.fn().mockReturnValue("tpc_"),
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

import { clusterSymbols } from "./clustering/index.js";
import { traceProcesses } from "./processes/index.js";
import { resolveReferences } from "./resolution/index.js";
import { extractAllSymbols } from "./parsing/index.js";
import { buildSearchIndex } from "./search/index.js";
import { indexSymbol } from "../vector/index-store.js";
import { runIndexingPipeline } from "./pipeline.js";
import type { GraphEdge } from "../graph/connection.js";
import type { Relationship, Symbol, Embedding } from "../types/index.js";

/** Minimal stub symbol — ensures pipeline passes the symbols.length === 0 guard */
const STUB_SYMBOL: Symbol = {
  id: "stub",
  name: "stub",
  kind: "function",
  location: { filePath: "stub.ts", startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
  visibility: "public",
  modifiers: [],
};

/** Minimal Neo4j session stub */
function makeSession() {
  return {} as import("neo4j-driver").Session;
}

/** Minimal pg Pool stub */
function makePool() {
  return {} as import("pg").Pool;
}

/** Collect all GraphEdge[] arrays passed to storeEdges across all calls */
function capturedEdges(): GraphEdge[] {
  return mockStoreEdges.mock.calls.flatMap((call) => call[1] as GraphEdge[]);
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const symbolIdArb = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0);

/** Cluster with at least 1 symbol (scoped to concrete failing cases) */
const clusterArb: fc.Arbitrary<Cluster> = fc
  .record({
    id: symbolIdArb,
    name: fc.string({ minLength: 1 }),
    symbols: fc.array(symbolIdArb, { minLength: 1, maxLength: 5 }),
    confidence: fc.float({ min: 0, max: 1, noNaN: true }),
    category: fc.constantFrom(
      "authentication" as const,
      "dataAccess" as const,
      "businessLogic" as const,
      "utility" as const,
      "unknown" as const,
    ),
  })
  .filter((c) => !c.symbols.includes(c.id));

/** ProcessStep */
const stepArb = (order: number): fc.Arbitrary<ProcessStep> =>
  fc.record({
    order: fc.constant(order),
    symbolId: symbolIdArb,
    description: fc.string(),
  });

/** Process with at least 1 step (scoped to concrete failing cases) */
const processArb: fc.Arbitrary<Process> = fc
  .integer({ min: 1, max: 4 })
  .chain((stepCount) =>
    fc.record({
      id: symbolIdArb,
      name: fc.string({ minLength: 1 }),
      entryPoint: symbolIdArb,
      steps: fc.tuple(...Array.from({ length: stepCount }, (_, i) => stepArb(i))) as unknown as fc.Arbitrary<ProcessStep[]>,
      dataFlow: fc.constant([]),
    })
  )
  .filter((p) => p.steps.length >= 1);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildGraph — cluster and process edge direction (bug condition exploration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cluster edges: source MUST be cluster.id and relType MUST be CONTAINS", async () => {
    await fc.assert(
      fc.asyncProperty(clusterArb, async (cluster) => {
        vi.clearAllMocks();
        vi.mocked(extractAllSymbols).mockResolvedValue({ symbols: [STUB_SYMBOL], hints: [] });
        vi.mocked(clusterSymbols).mockResolvedValue([cluster]);
        vi.mocked(traceProcesses).mockReturnValue([]);

        await runIndexingPipeline({
          sourcePath: ".",
          language: "typescript",
          verbose: false,
          graphSession: makeSession(),
          vectorPool: makePool(),
        });

        const edges = capturedEdges().filter(
          (e) => e.relType === "CONTAINS" || e.relType === "BELONGS_TO",
        );

        // Every cluster membership edge must point FROM cluster TO symbol
        for (const edge of edges) {
          expect(edge.relType).toBe("CONTAINS");
          expect(edge.source).toBe(cluster.id);
          expect(cluster.symbols).toContain(edge.target);
        }

        // There must be exactly one edge per symbol
        expect(edges).toHaveLength(cluster.symbols.length);
      }),
      { numRuns: 20 },
    );
  });

  it("process edges: source MUST be process.id and relType MUST be HAS_STEP", async () => {
    await fc.assert(
      fc.asyncProperty(processArb, async (process) => {
        vi.clearAllMocks();
        vi.mocked(extractAllSymbols).mockResolvedValue({ symbols: [STUB_SYMBOL], hints: [] });
        vi.mocked(clusterSymbols).mockResolvedValue([]);
        vi.mocked(traceProcesses).mockReturnValue([process]);

        await runIndexingPipeline({
          sourcePath: ".",
          language: "typescript",
          verbose: false,
          graphSession: makeSession(),
          vectorPool: makePool(),
        });

        const edges = capturedEdges().filter(
          (e) => e.relType === "HAS_STEP" || e.relType === "PART_OF",
        );

        // Every process step edge must point FROM process TO symbol
        for (const edge of edges) {
          expect(edge.relType).toBe("HAS_STEP");
          expect(edge.source).toBe(process.id);
        }

        expect(edges).toHaveLength(process.steps.length);
      }),
      { numRuns: 20 },
    );
  });

  it("process step edges: order property MUST equal String(step.order)", async () => {
    await fc.assert(
      fc.asyncProperty(processArb, async (process) => {
        vi.clearAllMocks();
        vi.mocked(extractAllSymbols).mockResolvedValue({ symbols: [STUB_SYMBOL], hints: [] });
        vi.mocked(clusterSymbols).mockResolvedValue([]);
        vi.mocked(traceProcesses).mockReturnValue([process]);

        await runIndexingPipeline({
          sourcePath: ".",
          language: "typescript",
          verbose: false,
          graphSession: makeSession(),
          vectorPool: makePool(),
        });

        const edges = capturedEdges().filter(
          (e) => e.relType === "HAS_STEP" || e.relType === "PART_OF",
        );

        for (let i = 0; i < process.steps.length; i++) {
          const step = process.steps[i];
          const edge = edges.find((e) => e.target === step.symbolId || e.source === step.symbolId);
          expect(edge).toBeDefined();
          expect(edge!.properties.order).toBe(String(step.order));
        }
      }),
      { numRuns: 20 },
    );
  });
});

/**
 * Property 2: Preservation — Relationship Edges and Node Writes Are Unchanged
 *
 * These tests run on UNFIXED code and MUST PASS.
 * They confirm the baseline behavior that the fix must not break.
 *
 * Requirements: 3.1, 3.5
 */
describe("buildGraph — preservation (baseline must hold before and after fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Arbitraries ────────────────────────────────────────────────────────────

  const relTypeArb = fc.constantFrom(
    "calls" as const,
    "imports" as const,
    "inherits" as const,
    "implements" as const,
    "contains" as const,
    "references" as const,
    "defines" as const,
  );

  const relationshipArb: fc.Arbitrary<Relationship> = fc.record({
    id: fc.string({ minLength: 1 }),
    source: fc.string({ minLength: 1 }),
    target: fc.string({ minLength: 1 }),
    relType: relTypeArb,
    metadata: fc.dictionary(fc.string({ minLength: 1 }), fc.string()),
  });

  // ─── Tests ──────────────────────────────────────────────────────────────────

  it("relationship edges: source, target, and relType are stored unchanged for all Relationship[] inputs", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(relationshipArb, { minLength: 1, maxLength: 10 }),
        async (relationships) => {
          vi.clearAllMocks();
          vi.mocked(extractAllSymbols).mockResolvedValue({ symbols: [STUB_SYMBOL], hints: [] });
          vi.mocked(resolveReferences).mockReturnValue(relationships);
          vi.mocked(clusterSymbols).mockResolvedValue([]);
          vi.mocked(traceProcesses).mockReturnValue([]);

          await runIndexingPipeline({
            sourcePath: ".",
            language: "typescript",
            verbose: false,
            graphSession: makeSession(),
            vectorPool: makePool(),
          });

          const emitted = capturedEdges();

          // Every relationship must appear in emitted edges with matching fields
          for (const rel of relationships) {
            const match = emitted.find(
              (e) =>
                e.source === rel.source &&
                e.target === rel.target &&
                e.relType === rel.relType.toUpperCase(),
            );
            expect(match).toBeDefined();
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  it("empty clusters and processes: no cluster or process edges are emitted", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(relationshipArb, { maxLength: 5 }),
        async (relationships) => {
          vi.clearAllMocks();
          vi.mocked(extractAllSymbols).mockResolvedValue({ symbols: [STUB_SYMBOL], hints: [] });
          vi.mocked(resolveReferences).mockReturnValue(relationships);
          vi.mocked(clusterSymbols).mockResolvedValue([]);
          vi.mocked(traceProcesses).mockReturnValue([]);

          await runIndexingPipeline({
            sourcePath: ".",
            language: "typescript",
            verbose: false,
            graphSession: makeSession(),
            vectorPool: makePool(),
          });

          const emitted = capturedEdges();

          // On unfixed code, cluster/process edges use BELONGS_TO and PART_OF.
          // Neither should appear when clusters and processes arrays are empty.
          const clusterOrProcessEdges = emitted.filter((e) =>
            e.relType === "BELONGS_TO" || e.relType === "PART_OF",
          );
          expect(clusterOrProcessEdges).toHaveLength(0);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("process step order: each emitted step edge has properties.order === String(step.order)", async () => {
    // Build a process arbitrary with at least 2 steps (matching Process invariant)
    const stepArb2 = (order: number): fc.Arbitrary<ProcessStep> =>
      fc.record({
        order: fc.constant(order),
        symbolId: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
        description: fc.string(),
      });

    const processWithStepsArb: fc.Arbitrary<Process> = fc
      .integer({ min: 2, max: 5 })
      .chain((stepCount) =>
        fc.record({
          id: fc.string({ minLength: 1 }),
          name: fc.string({ minLength: 1 }),
          entryPoint: fc.string({ minLength: 1 }),
          steps: fc.tuple(
            ...Array.from({ length: stepCount }, (_, i) => stepArb2(i)),
          ) as unknown as fc.Arbitrary<ProcessStep[]>,
          dataFlow: fc.constant([]),
        }),
      );

    await fc.assert(
      fc.asyncProperty(processWithStepsArb, async (process) => {
        vi.clearAllMocks();
        vi.mocked(extractAllSymbols).mockResolvedValue({ symbols: [STUB_SYMBOL], hints: [] });
        vi.mocked(resolveReferences).mockReturnValue([]);
        vi.mocked(clusterSymbols).mockResolvedValue([]);
        vi.mocked(traceProcesses).mockReturnValue([process]);

        await runIndexingPipeline({
          sourcePath: ".",
          language: "typescript",
          verbose: false,
          graphSession: makeSession(),
          vectorPool: makePool(),
        });

        // Collect step edges (PART_OF on unfixed code, HAS_STEP after fix — both checked)
        const stepEdges = capturedEdges().filter(
          (e) => e.relType === "PART_OF" || e.relType === "HAS_STEP",
        );

        expect(stepEdges).toHaveLength(process.steps.length);

        for (const step of process.steps) {
          // Find the edge associated with this step's symbolId and order
          const edge = stepEdges.find(
            (e) =>
              (e.source === step.symbolId || e.target === step.symbolId) &&
              e.properties.order === String(step.order),
          );
          expect(edge).toBeDefined();
          expect(edge!.properties.order).toBe(String(step.order));
        }
      }),
      { numRuns: 20 },
    );
  });
});

/**
 * Task 2.1 — Unit tests for Phase 6 graceful degradation and embedding persistence
 * Requirements: 3.6
 */
describe("Phase 6 — embedding generation and persistence", () => {
  const STUB_EMBEDDING: Embedding = {
    vector: Array.from({ length: 1536 }, () => 0.1),
    dimensions: 1536,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(extractAllSymbols).mockResolvedValue({ symbols: [STUB_SYMBOL], hints: [] });
    vi.mocked(resolveReferences).mockReturnValue([]);
    vi.mocked(clusterSymbols).mockResolvedValue([]);
    vi.mocked(traceProcesses).mockReturnValue([]);
  });

  it("should return embeddingCount === 0 and not call indexSymbol when OPENAI_API_KEY is absent", async () => {
    delete process.env.OPENAI_API_KEY;

    vi.mocked(buildSearchIndex).mockResolvedValue({
      keywords: new Map(),
      symbolCount: 1,
      embeddings: [],
    });

    const result = await runIndexingPipeline({
      sourcePath: ".",
      language: "typescript",
      verbose: false,
      graphSession: makeSession(),
      vectorPool: makePool(),
    });

    expect(result.embeddingCount).toBe(0);
    expect(vi.mocked(indexSymbol)).not.toHaveBeenCalled();
  });

  it("should call indexSymbol once per non-null embedding result when OPENAI_API_KEY is present", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    vi.mocked(buildSearchIndex).mockResolvedValue({
      keywords: new Map(),
      symbolCount: 1,
      embeddings: [
        { symbolId: "sym-1", embedding: STUB_EMBEDDING },
        { symbolId: "sym-2", embedding: STUB_EMBEDDING },
      ],
    });

    const result = await runIndexingPipeline({
      sourcePath: ".",
      language: "typescript",
      verbose: false,
      graphSession: makeSession(),
      vectorPool: makePool(),
    });

    expect(result.embeddingCount).toBe(2);
    expect(vi.mocked(indexSymbol)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(indexSymbol)).toHaveBeenCalledWith(
      expect.anything(),
      "sym-1",
      STUB_EMBEDDING,
      undefined,
      "tpc_",
    );
    expect(vi.mocked(indexSymbol)).toHaveBeenCalledWith(
      expect.anything(),
      "sym-2",
      STUB_EMBEDDING,
      undefined,
      "tpc_",
    );

    delete process.env.OPENAI_API_KEY;
  });

  it("should propagate DB errors from indexSymbol (hard error)", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    vi.mocked(buildSearchIndex).mockResolvedValue({
      keywords: new Map(),
      symbolCount: 1,
      embeddings: [{ symbolId: "sym-1", embedding: STUB_EMBEDDING }],
    });

    vi.mocked(indexSymbol).mockRejectedValueOnce(new Error("DB write failed"));

    await expect(
      runIndexingPipeline({
        sourcePath: ".",
        language: "typescript",
        verbose: false,
        graphSession: makeSession(),
        vectorPool: makePool(),
      }),
    ).rejects.toThrow("DB write failed");

    delete process.env.OPENAI_API_KEY;
  });
});
