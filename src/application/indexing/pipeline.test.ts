/**
 * Unit tests for the indexer pipeline with mocked DatabaseAdapter.
 *
 * Validates:
 * - Pipeline runs with mocked adapter (Req 8.1)
 * - Phase 6 uses EmbeddingAdapter when enabled (Req 8.2)
 * - Phase 6 skips embeddings when disabled (Req 8.3)
 * - Keyword indexing works regardless of embedding state (Req 8.5)
 * - storeInDatabases uses GraphAdapter methods (Req 8.1)
 * - VectorAdapter.indexSymbol is called for each embedding (Req 8.4)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Symbol, Cluster, Process, Relationship, Embedding, ExternalDependencyNode } from "../../core/domain.js";
import type { DatabaseAdapter, GraphAdapter, VectorAdapter, EmbeddingAdapter } from "../../core/ports/persistence.js";

// ─── Stub data ────────────────────────────────────────────────────────────────

const STUB_SYMBOL: Symbol = {
  id: "stub",
  logicalKey: "stub",
  name: "stub",
  kind: "function",
  location: { filePath: "stub.ts", startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
  visibility: "public",
  modifiers: [],
};

const STUB_EMBEDDING: Embedding = {
  vector: Array.from({ length: 2560 }, () => 0.1),
  dimensions: 2560,
};

// ─── Module mocks ─────────────────────────────────────────────────────────────

const {
  mockWalkFileTree,
  mockExtractAllSymbols,
  mockResolveReferences,
  mockClusterSymbols,
  mockTraceProcesses,
  mockAnnotateEntryPoints,
  mockBuildSearchIndex,
} = vi.hoisted(() => ({
  mockWalkFileTree: vi.fn(),
  mockExtractAllSymbols: vi.fn(),
  mockResolveReferences: vi.fn(),
  mockClusterSymbols: vi.fn(),
  mockTraceProcesses: vi.fn(),
  // Wave 2: pass-through by default (returns the symbols unchanged) so the
  // pipeline's observable persisted shape under test is unaffected.
  mockAnnotateEntryPoints: vi.fn((symbols: unknown) => symbols),
  mockBuildSearchIndex: vi.fn(),
}));

vi.mock("./structure/index.js", () => ({ walkFileTree: mockWalkFileTree }));
vi.mock("./parsing/index.js", () => ({ extractAllSymbols: mockExtractAllSymbols }));
vi.mock("./resolution/index.js", () => ({ resolveReferences: mockResolveReferences }));
vi.mock("./clustering/index.js", () => ({ clusterSymbols: mockClusterSymbols }));
vi.mock("./processes/index.js", () => ({
  traceProcesses: mockTraceProcesses,
  annotateEntryPoints: mockAnnotateEntryPoints,
}));
vi.mock("./search/index.js", () => ({ buildSearchIndex: mockBuildSearchIndex }));
vi.mock("../../platform/config/index.js", () => ({
  configurationManager: { getPrefix: () => "tpc_" },
}));

// ─── Import under test ───────────────────────────────────────────────────────

import { runIndexingPipeline, countPersistRows } from "./pipeline.js";

// ─── Adapter factories ────────────────────────────────────────────────────────

function makeMockGraphAdapter(): GraphAdapter {
  return {
    createNode: vi.fn().mockResolvedValue(undefined),
    createRelationship: vi.fn().mockResolvedValue(undefined),
    queryNodes: vi.fn().mockResolvedValue([]),
    queryRelationships: vi.fn().mockResolvedValue([]),
    deleteNodesByLabel: vi.fn().mockResolvedValue(0),
    deleteRelationshipsByType: vi.fn().mockResolvedValue(0),
    runCypher: vi.fn().mockResolvedValue([]),
    runCypherWrite: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockVectorAdapter(): VectorAdapter {
  return {
    createTables: vi.fn().mockResolvedValue(undefined),
    indexSymbol: vi.fn().mockResolvedValue(undefined),
    semanticSearch: vi.fn().mockResolvedValue([]),
    deleteAll: vi.fn().mockResolvedValue(0),
  };
}

function makeMockEmbeddingAdapter(enabled: boolean): EmbeddingAdapter {
  return {
    isEnabled: vi.fn().mockReturnValue(enabled),
    embedText: vi.fn().mockResolvedValue(enabled ? STUB_EMBEDDING : null),
    getDimensions: vi.fn().mockReturnValue(2560),
  };
}

function makeMockAdapter(embeddingsEnabled: boolean): {
  adapter: DatabaseAdapter;
  graph: GraphAdapter;
  vector: VectorAdapter;
  embedding: EmbeddingAdapter;
} {
  const graph = makeMockGraphAdapter();
  const vector = makeMockVectorAdapter();
  const embedding = makeMockEmbeddingAdapter(embeddingsEnabled);
  const adapter: DatabaseAdapter = {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getGraphAdapter: vi.fn().mockReturnValue(graph),
    getVectorAdapter: vi.fn().mockReturnValue(vector),
    getEmbeddingAdapter: vi.fn().mockReturnValue(embedding),
  };
  return { adapter, graph, vector, embedding };
}

function setupDefaultMocks(): void {
  mockWalkFileTree.mockResolvedValue([{ path: "src/stub.ts", size: 100 }]);
  mockExtractAllSymbols.mockResolvedValue({ symbols: [STUB_SYMBOL], hints: [], skippedFiles: 0 });
  mockResolveReferences.mockReturnValue({ relationships: [], extNodes: new Map() });
  mockClusterSymbols.mockResolvedValue([]);
  mockTraceProcesses.mockReturnValue([]);
  // Wave 2: keep annotateEntryPoints a pass-through after clearAllMocks.
  mockAnnotateEntryPoints.mockImplementation((symbols: unknown) => symbols);
  mockBuildSearchIndex.mockResolvedValue({
    keywords: new Map(), symbolCount: 1, embeddings: [],
    embeddingStats: { attempts: 0, successes: 0, failures: 0 },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runIndexingPipeline — DatabaseAdapter integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("should return empty result when no files found", async () => {
    const { adapter } = makeMockAdapter(false);
    mockWalkFileTree.mockResolvedValue([]);

    const result = await runIndexingPipeline({
      sourcePath: ".",
      language: "typescript",
      verbose: false,
      adapter,
    });

    expect(result.symbols).toHaveLength(0);
    expect(result.embeddingCount).toBe(0);
    expect(result.externalDependencyCount).toBe(0);
  });

  it("should store graph data through GraphAdapter (Req 8.1)", async () => {
    const { adapter, graph } = makeMockAdapter(false);

    const cluster: Cluster = {
      id: "cluster-1", name: "Auth", symbols: ["stub", "stub2"],
      confidence: 0.9, category: "authentication",
    };
    const process: Process = {
      id: "proc-1", name: "Login", entryPoint: "stub",
      steps: [
        { order: 0, symbolId: "stub", description: "entry" },
        { order: 1, symbolId: "stub2", description: "next" },
      ],
      dataFlow: [],
    };
    const relationship: Relationship = {
      id: "rel-1", source: "stub", target: "stub2", relType: "calls", metadata: {},
    };

    mockExtractAllSymbols.mockResolvedValue({
      symbols: [STUB_SYMBOL, { ...STUB_SYMBOL, id: "stub2", logicalKey: "stub2", name: "stub2" }],
      hints: [], skippedFiles: 0,
    });
    mockResolveReferences.mockReturnValue({ relationships: [relationship], extNodes: new Map() });
    mockClusterSymbols.mockResolvedValue([cluster]);
    mockTraceProcesses.mockReturnValue([process]);

    const result = await runIndexingPipeline({
      sourcePath: ".", language: "typescript", verbose: false, adapter,
    });

    expect(result.symbols).toHaveLength(2);
    expect(result.clusters).toHaveLength(1);
    expect(result.processes).toHaveLength(1);

    // 2 symbols + 1 cluster + 1 process = 4 entity nodes + 1 lastIndexed
    // Metadata node (A4) = 5 createNode calls.
    expect(graph.createNode).toHaveBeenCalledTimes(5);
    // 1 relationship + 2 cluster membership + 2 process steps = 5 edges
    expect(graph.createRelationship).toHaveBeenCalledTimes(5);

    // Verify bare labels (adapter handles prefix internally)
    expect(graph.createNode).toHaveBeenCalledWith("Symbol", expect.objectContaining({ id: "stub" }));
    expect(graph.createNode).toHaveBeenCalledWith("Cluster", expect.objectContaining({ id: "cluster-1" }));
    expect(graph.createNode).toHaveBeenCalledWith("Process", expect.objectContaining({ id: "proc-1" }));
    // A4 / pre-existing bug 0.4: the lastIndexed Metadata node is written.
    expect(graph.createNode).toHaveBeenCalledWith(
      "Metadata",
      expect.objectContaining({ key: "lastIndexed", timestamp: expect.any(String) }),
    );

    // Verify bare edge types (adapter handles prefix internally)
    expect(graph.createRelationship).toHaveBeenCalledWith("stub", "stub2", "CALLS", {});
    expect(graph.createRelationship).toHaveBeenCalledWith("cluster-1", "stub", "CONTAINS", {});
    expect(graph.createRelationship).toHaveBeenCalledWith("proc-1", "stub", "HAS_STEP", { step_order: "0" });
  });

  // E2: complexity metrics persist on the Symbol node as STRING props.
  it("persists complexity metrics as string props on Symbol nodes (E2)", async () => {
    const { adapter, graph } = makeMockAdapter(false);
    const sym: Symbol = {
      ...STUB_SYMBOL,
      complexity: { cyclomatic: 7, cognitive: 11, maxLoopDepth: 2 },
    };
    mockExtractAllSymbols.mockResolvedValue({ symbols: [sym], hints: [], skippedFiles: 0 });

    await runIndexingPipeline({ sourcePath: ".", language: "typescript", verbose: false, adapter });

    expect(graph.createNode).toHaveBeenCalledWith(
      "Symbol",
      expect.objectContaining({ id: "stub", cyclomatic: "7", cognitive: "11", maxLoopDepth: "2" }),
    );
  });

  // E2: symbols WITHOUT complexity (non-callables, pre-E2) default to "0".
  it("defaults missing complexity props to '0' on Symbol nodes (E2)", async () => {
    const { adapter, graph } = makeMockAdapter(false);
    // STUB_SYMBOL has no `complexity` field.

    await runIndexingPipeline({ sourcePath: ".", language: "typescript", verbose: false, adapter });

    expect(graph.createNode).toHaveBeenCalledWith(
      "Symbol",
      expect.objectContaining({ id: "stub", cyclomatic: "0", cognitive: "0", maxLoopDepth: "0" }),
    );
  });

  it("stores external dependency nodes and DEPENDS_ON edges", async () => {
    const { adapter, graph } = makeMockAdapter(false);
    mockResolveReferences.mockReturnValue({
      relationships: [{
        id: "dep-1",
        source: "stub",
        target: "ext:lodash",
        relType: "dependsOn",
        metadata: { packageName: "lodash", ecosystem: "npm" },
      }],
      extNodes: new Map([["ext:lodash", {
        id: "ext:lodash",
        name: "lodash",
        aliases: ["lodash", "Lodash"],
        ecosystem: "npm",
      }]]),
    });

    const result = await runIndexingPipeline({
      sourcePath: ".",
      language: "typescript",
      verbose: false,
      adapter,
    });

    expect(result.externalDependencyCount).toBe(1);
    expect(graph.createNode).toHaveBeenCalledWith("ExternalDependency", expect.objectContaining({
      id: "ext:lodash",
      aliases: "lodash,Lodash",
      ecosystem: "npm",
    }));
    expect(graph.createRelationship).toHaveBeenCalledWith("stub", "ext:lodash", "DEPENDS_ON", {
      packageName: "lodash",
      ecosystem: "npm",
    });
  });

  // A1 (KEYSTONE): the PERSISTED graph keys nodes/edges/vectors on `logicalKey`,
  // not the intra-run `id`. The pipeline maps id → logicalKey at the persist
  // boundary; synthetic endpoints (ext:/import:/unresolved:) fall through.
  it("persists nodes, edges, and vectors keyed on logicalKey; synthetic ids pass through (A1)", async () => {
    const { adapter, graph, vector } = makeMockAdapter(true);

    // Two symbols whose persisted logicalKey DIFFERS from their intra-run id.
    const symA: Symbol = { ...STUB_SYMBOL, id: "src/a.ts:Foo:1:0", logicalKey: "lk-foo", name: "Foo" };
    const symB: Symbol = { ...STUB_SYMBOL, id: "src/a.ts:Bar:9:0", logicalKey: "lk-bar", name: "Bar" };

    const cluster: Cluster = {
      id: "cluster-1", name: "Auth", symbols: [symA.id, symB.id],
      confidence: 0.9, category: "authentication",
    };
    const process: Process = {
      id: "proc-1", name: "Flow", entryPoint: symA.id,
      steps: [
        { order: 0, symbolId: symA.id, description: "entry" },
        { order: 1, symbolId: symB.id, description: "next" },
      ],
      dataFlow: [],
    };
    // One symbol→symbol edge (both endpoints map), one synthetic import edge whose
    // SOURCE is synthetic (passes through) and TARGET is a real symbol (maps).
    const relationships: Relationship[] = [
      { id: "r1", source: symA.id, target: symB.id, relType: "calls", metadata: {} },
      { id: "r2", source: "src/a.ts:import:./b", target: symB.id, relType: "imports", metadata: {} },
    ];

    mockExtractAllSymbols.mockResolvedValue({ symbols: [symA, symB], hints: [], skippedFiles: 0 });
    mockResolveReferences.mockReturnValue({ relationships, extNodes: new Map() });
    mockClusterSymbols.mockResolvedValue([cluster]);
    mockTraceProcesses.mockReturnValue([process]);
    mockBuildSearchIndex.mockResolvedValue({
      keywords: new Map(), symbolCount: 2,
      embeddings: [{ symbolId: symA.id, embedding: STUB_EMBEDDING, metadata: {} }],
      embeddingStats: { attempts: 1, successes: 1, failures: 0 },
    });

    await runIndexingPipeline({ sourcePath: ".", language: "typescript", verbose: false, adapter });

    // Node ids are logicalKeys, not intra-run ids.
    expect(graph.createNode).toHaveBeenCalledWith("Symbol", expect.objectContaining({ id: "lk-foo" }));
    expect(graph.createNode).toHaveBeenCalledWith("Symbol", expect.objectContaining({ id: "lk-bar" }));
    // Process entryPoint maps too.
    expect(graph.createNode).toHaveBeenCalledWith("Process", expect.objectContaining({ entryPoint: "lk-foo" }));

    // Symbol→symbol edge: both endpoints mapped.
    expect(graph.createRelationship).toHaveBeenCalledWith("lk-foo", "lk-bar", "CALLS", {});
    // Synthetic import source passes through unchanged; real target maps.
    expect(graph.createRelationship).toHaveBeenCalledWith("src/a.ts:import:./b", "lk-bar", "IMPORTS", {});
    // CONTAINS / HAS_STEP membership edges map their symbol endpoints.
    expect(graph.createRelationship).toHaveBeenCalledWith("cluster-1", "lk-foo", "CONTAINS", {});
    expect(graph.createRelationship).toHaveBeenCalledWith("proc-1", "lk-bar", "HAS_STEP", { step_order: "1" });
    // Vector symbolId maps to logicalKey.
    expect(vector.indexSymbol).toHaveBeenCalledWith("lk-foo", STUB_EMBEDDING, {});
  });
});

describe("storeInDatabases — batch fast-path (Phase D / PR7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("routes through batch methods when present; metrics count ROWS, not batch calls", async () => {
    const { adapter, graph, vector } = makeMockAdapter(true);
    // Equip the adapters with the OPTIONAL batch methods.
    (graph as { createNodes?: ReturnType<typeof vi.fn> }).createNodes = vi
      .fn()
      .mockResolvedValue(undefined);
    (graph as { createRelationships?: ReturnType<typeof vi.fn> }).createRelationships = vi
      .fn()
      .mockResolvedValue(undefined);
    (vector as { indexSymbols?: ReturnType<typeof vi.fn> }).indexSymbols = vi
      .fn()
      .mockResolvedValue(undefined);

    const cluster: Cluster = {
      id: "cluster-1", name: "Auth", symbols: ["stub", "stub2"],
      confidence: 0.9, category: "authentication",
    };
    const process: Process = {
      id: "proc-1", name: "Login", entryPoint: "stub",
      steps: [
        { order: 0, symbolId: "stub", description: "entry" },
        { order: 1, symbolId: "stub2", description: "next" },
      ],
      dataFlow: [],
    };
    const relationship: Relationship = {
      id: "rel-1", source: "stub", target: "stub2", relType: "calls", metadata: {},
    };

    mockExtractAllSymbols.mockResolvedValue({
      symbols: [STUB_SYMBOL, { ...STUB_SYMBOL, id: "stub2", logicalKey: "stub2", name: "stub2" }],
      hints: [], skippedFiles: 0,
    });
    mockResolveReferences.mockReturnValue({ relationships: [relationship], extNodes: new Map() });
    mockClusterSymbols.mockResolvedValue([cluster]);
    mockTraceProcesses.mockReturnValue([process]);
    mockBuildSearchIndex.mockResolvedValue({
      keywords: new Map(), symbolCount: 2,
      embeddings: [
        { symbolId: "stub", embedding: STUB_EMBEDDING, metadata: {} },
        { symbolId: "stub2", embedding: STUB_EMBEDDING, metadata: {} },
      ],
      embeddingStats: { attempts: 2, successes: 2, failures: 0 },
    });

    const result = await runIndexingPipeline({
      sourcePath: ".", language: "typescript", verbose: false, adapter,
    });

    const createNodes = (graph as unknown as { createNodes: ReturnType<typeof vi.fn> }).createNodes;
    const createRelationships = (graph as unknown as { createRelationships: ReturnType<typeof vi.fn> }).createRelationships;
    const indexSymbols = (vector as unknown as { indexSymbols: ReturnType<typeof vi.fn> }).indexSymbols;

    // Batch path taken — per-row methods untouched.
    expect(graph.createNode).not.toHaveBeenCalled();
    expect(graph.createRelationship).not.toHaveBeenCalled();
    expect(vector.indexSymbol).not.toHaveBeenCalled();

    // Nodes grouped by label, all rows present in batches.
    const nodeBatches = createNodes.mock.calls as Array<[string, Array<Record<string, unknown>>]>;
    const nodeRowsByLabel = new Map<string, Array<Record<string, unknown>>>();
    for (const [label, part] of nodeBatches) {
      expect(part.length).toBeLessThanOrEqual(500);
      nodeRowsByLabel.set(label, [...(nodeRowsByLabel.get(label) ?? []), ...part]);
    }
    expect(nodeRowsByLabel.get("Symbol")).toHaveLength(2);
    expect(nodeRowsByLabel.get("Cluster")).toHaveLength(1);
    expect(nodeRowsByLabel.get("Process")).toHaveLength(1);
    // A4: the lastIndexed Metadata node is also routed through the batch path.
    expect(nodeRowsByLabel.get("Metadata")).toHaveLength(1);
    expect(nodeRowsByLabel.get("Metadata")![0]).toMatchObject({ key: "lastIndexed" });

    // Relationships grouped by type.
    const relTypes = (createRelationships.mock.calls as Array<[string, unknown[]]>).map(([t]) => t);
    expect(relTypes).toEqual(expect.arrayContaining(["CALLS", "CONTAINS", "HAS_STEP"]));

    // Vector entries batched.
    const vecBatches = indexSymbols.mock.calls as Array<[Array<unknown>]>;
    expect(vecBatches.flatMap(([part]) => part)).toHaveLength(2);

    // Metrics count ROWS, not batch calls.
    // 2 symbols + 1 cluster + 1 process = 4 node rows. The lastIndexed Metadata
    // node uses a no-op onRows (A4), so it is intentionally NOT counted here.
    expect(result.metrics.graphNodeWrites).toBe(4);
    // 1 CALLS + 2 CONTAINS + 2 HAS_STEP = 5 edge rows.
    expect(result.metrics.graphEdgeWrites).toBe(5);
    expect(result.metrics.vectorWrites).toBe(2);
    expect(result.embeddingCount).toBe(2);

    // Phase B batch-level counters: count CALLS, not rows. These small fixtures
    // fit a single chunk per group, so each non-empty group is one batch call.
    // Entity node groups: Symbol, Cluster, Process (ExternalDependency empty).
    // The lastIndexed Metadata write (A4) ALSO issues a createNodes call but is
    // deliberately wired WITHOUT batch events, so it adds a createNodes call
    // without bumping nodeBatchCount.
    expect(createNodes.mock.calls.length).toBe(4);
    expect(result.metrics.nodeBatchCount).toBe(3);
    // Relationship groups: CALLS, CONTAINS, HAS_STEP.
    expect(result.metrics.relationshipBatchCount).toBe(createRelationships.mock.calls.length);
    expect(result.metrics.relationshipBatchCount).toBe(3);
    // One vector batch call.
    expect(result.metrics.vectorBatchCount).toBe(indexSymbols.mock.calls.length);
    expect(result.metrics.vectorBatchCount).toBe(1);
    // No splits or oversized rows on this happy path.
    expect(result.metrics.adaptiveSplitCount).toBe(0);
    expect(result.metrics.oversizedRowCount).toBe(0);
  });
});

describe("Phase 6 — EmbeddingAdapter and VectorAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("should use EmbeddingAdapter.embedText when enabled (Req 8.2)", async () => {
    const { adapter, embedding } = makeMockAdapter(true);

    mockBuildSearchIndex.mockImplementation(async (_s: unknown, _c: unknown, embedFn: unknown) => {
      expect(embedFn).not.toBeNull();
      if (typeof embedFn === "function") await embedFn("test text");
      return {
        keywords: new Map(), symbolCount: 1, embeddings: [],
        embeddingStats: { attempts: 0, successes: 0, failures: 0 },
      };
    });

    await runIndexingPipeline({ sourcePath: ".", language: "typescript", verbose: false, adapter });

    expect(embedding.embedText).toHaveBeenCalledWith("test text");
  });

  it("should skip embeddings when EmbeddingAdapter.isEnabled() is false (Req 8.3)", async () => {
    const { adapter, embedding } = makeMockAdapter(false);

    mockBuildSearchIndex.mockImplementation(async (_s: unknown, _c: unknown, embedFn: unknown) => {
      expect(embedFn).toBeNull();
      return {
        keywords: new Map(), symbolCount: 1, embeddings: [],
        embeddingStats: { attempts: 0, successes: 0, failures: 0 },
      };
    });

    await runIndexingPipeline({ sourcePath: ".", language: "typescript", verbose: false, adapter });

    expect(embedding.isEnabled).toHaveBeenCalled();
    expect(embedding.embedText).not.toHaveBeenCalled();
  });

  it("should store embeddings through VectorAdapter.indexSymbol (Req 8.4)", async () => {
    const { adapter, vector } = makeMockAdapter(true);

    mockBuildSearchIndex.mockResolvedValue({
      keywords: new Map(), symbolCount: 1,
      embeddings: [
        { symbolId: "sym-1", embedding: STUB_EMBEDDING, metadata: { clusterId: "c1" } },
        { symbolId: "sym-2", embedding: STUB_EMBEDDING, metadata: { clusterId: "c2" } },
      ],
      embeddingStats: { attempts: 2, successes: 2, failures: 0 },
    });

    const result = await runIndexingPipeline({ sourcePath: ".", language: "typescript", verbose: false, adapter });

    expect(result.embeddingCount).toBe(2);
    expect(vector.indexSymbol).toHaveBeenCalledTimes(2);
    expect(vector.indexSymbol).toHaveBeenCalledWith("sym-1", STUB_EMBEDDING, { clusterId: "c1" });
    expect(vector.indexSymbol).toHaveBeenCalledWith("sym-2", STUB_EMBEDDING, { clusterId: "c2" });
  });

  it("should build keyword index regardless of embedding state (Req 8.5)", async () => {
    const { adapter } = makeMockAdapter(false);

    await runIndexingPipeline({ sourcePath: ".", language: "typescript", verbose: false, adapter });

    expect(mockBuildSearchIndex).toHaveBeenCalledTimes(1);
    // embedFn arg should be null when disabled
    expect(mockBuildSearchIndex.mock.calls[0]?.[2]).toBeNull();
  });

  it("should return embeddingCount 0 when embeddings are disabled (Req 8.3)", async () => {
    const { adapter, vector } = makeMockAdapter(false);

    const result = await runIndexingPipeline({ sourcePath: ".", language: "typescript", verbose: false, adapter });

    expect(result.embeddingCount).toBe(0);
    expect(vector.indexSymbol).not.toHaveBeenCalled();
  });

  it("surfaces embedding failure counts in metrics and logs them, without failing (Phase C)", async () => {
    const { adapter, vector } = makeMockAdapter(true);
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Some succeeded, some failed (null/timeout/error → keyword-only).
    mockBuildSearchIndex.mockResolvedValue({
      keywords: new Map([["user", ["sym-1"]]]), symbolCount: 1,
      embeddings: [
        { symbolId: "sym-1", embedding: STUB_EMBEDDING, metadata: {} },
      ],
      embeddingStats: { attempts: 3, successes: 1, failures: 2 },
    });

    try {
      const result = await runIndexingPipeline({ sourcePath: ".", language: "typescript", verbose: false, adapter });

      // Pipeline did NOT fail; successful embedding still stored.
      expect(result.embeddingCount).toBe(1);
      expect(vector.indexSymbol).toHaveBeenCalledTimes(1);
      // Failure counts surfaced in metrics.
      expect(result.metrics.embeddingAttempts).toBe(3);
      expect(result.metrics.embeddingFailures).toBe(2);
      // Failures logged (not silently swallowed), on stderr.
      const logged = stderrSpy.mock.calls.some(([msg]) =>
        typeof msg === "string" && msg.includes("2 of 3") && msg.includes("failed"),
      );
      expect(logged).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("passes semanticClassification through to clusterSymbols (default true)", async () => {
    const { adapter } = makeMockAdapter(true);
    await runIndexingPipeline({ sourcePath: ".", language: "typescript", verbose: false, adapter });
    // arg order: symbols, relationships, aiClient, embeddingAdapter, semanticClassification
    expect(mockClusterSymbols.mock.calls[0]?.[4]).toBe(true);

    vi.clearAllMocks();
    setupDefaultMocks();
    await runIndexingPipeline({
      sourcePath: ".", language: "typescript", verbose: false, adapter, semanticClassification: false,
    });
    expect(mockClusterSymbols.mock.calls[0]?.[4]).toBe(false);
  });
});

// ─── B6 progress wiring ─────────────────────────────────────────────────────

describe("runIndexingPipeline — Phase 2 progress (B6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("passes an onProgress callback to extractAllSymbols", async () => {
    const { adapter } = makeMockAdapter(false);
    await runIndexingPipeline({ sourcePath: ".", language: "typescript", verbose: false, adapter });

    expect(mockExtractAllSymbols).toHaveBeenCalledTimes(1);
    const options = mockExtractAllSymbols.mock.calls[0]?.[2] as { onProgress?: unknown } | undefined;
    expect(typeof options?.onProgress).toBe("function");
  });

  it("writes nothing to stdout, even when extractAllSymbols drives onProgress", async () => {
    const { adapter } = makeMockAdapter(false);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    // Drive the supplied hook like the real bounded-concurrency loop would,
    // including a skipped file so the counter still reaches total.
    mockExtractAllSymbols.mockImplementation(
      async (_files: unknown, _root: unknown, opts: { onProgress?: (d: number, t: number, p?: string) => void } = {}) => {
        const total = 3;
        for (let done = 1; done <= total; done++) opts.onProgress?.(done, total, `f${done}.ts`);
        return { symbols: [STUB_SYMBOL], hints: [], skippedFiles: 1 };
      },
    );

    try {
      await runIndexingPipeline({ sourcePath: ".", language: "typescript", verbose: false, adapter });
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("stays quiet (no stderr progress chatter) in non-TTY non-verbose mode", async () => {
    const { adapter } = makeMockAdapter(false);
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    mockExtractAllSymbols.mockImplementation(
      async (_files: unknown, _root: unknown, opts: { onProgress?: (d: number, t: number, p?: string) => void } = {}) => {
        for (let done = 1; done <= 5; done++) opts.onProgress?.(done, 5, `f${done}.ts`);
        return { symbols: [STUB_SYMBOL], hints: [], skippedFiles: 0 };
      },
    );

    try {
      await runIndexingPipeline({ sourcePath: ".", language: "typescript", verbose: false, adapter });
      // The renderer must emit no progress lines in non-TTY non-verbose mode.
      // (Other pipeline stderr logging is gated behind verbose, so nothing here.)
      const progressWrites = stderrSpy.mock.calls.filter(([c]) =>
        typeof c === "string" && c.includes("Phase 2: parsing"),
      );
      expect(progressWrites).toHaveLength(0);
    } finally {
      stderrSpy.mockRestore();
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
    }
  });
});

describe("runIndexingPipeline — LadybugDB persistence progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("reports persisted vector and graph rows through the progress renderer", async () => {
    const { adapter } = makeMockAdapter(true);
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    mockBuildSearchIndex.mockResolvedValue({
      keywords: new Map(),
      symbolCount: 1,
      embeddings: [
        { symbolId: "stub", embedding: STUB_EMBEDDING, metadata: {} },
      ],
      embeddingStats: { attempts: 1, successes: 1, failures: 0 },
    });

    try {
      await runIndexingPipeline({ sourcePath: ".", language: "typescript", verbose: true, adapter });

      const progressWrites = stderrSpy.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((chunk) => chunk.includes("Indexing into LadybugDB"));

      expect(progressWrites.length).toBeGreaterThan(0);
      expect(progressWrites.some((chunk) => chunk.includes("1/2"))).toBe(true);
      expect(progressWrites.some((chunk) => chunk.includes("2/2") && chunk.includes("(100%)"))).toBe(true);
      for (const chunk of progressWrites) {
        expect(chunk).not.toContain("\x1b");
        expect(chunk).not.toContain("\r");
      }
    } finally {
      stderrSpy.mockRestore();
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
    }
  });
});

// ─── Persist progress drift guard (Phase A) ─────────────────────────────────────
//
// The persist progress total is computed by countPersistRows(...), which
// independently re-derives node/edge/vector counts. If storeInDatabases ever
// changes WHAT it writes without updating countPersistRows in lockstep, the bar
// stops short of / overshoots 100% and metrics desync. This guard makes that
// impossible to do silently: it sums every row reported via the persist onRows
// path and asserts the sum equals countPersistRows for a representative fixture,
// and that the progress renderer's final reported value reaches the total (100%).

describe("runIndexingPipeline — persist progress drift guard (Phase A)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("sum(persist onRows) === countPersistRows(...) and the bar reaches 100%", async () => {
    const { adapter } = makeMockAdapter(true);
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    // Representative fixture: symbols + clusters (with members → CONTAINS edges)
    // + processes (with steps → HAS_STEP edges) + external deps + relationships
    // (a normal CALLS edge AND a DEPENDS_ON edge). This exercises every branch
    // that storeInDatabases and countPersistRows must agree on.
    const symbols: Symbol[] = [
      STUB_SYMBOL,
      { ...STUB_SYMBOL, id: "stub2", logicalKey: "stub2", name: "stub2" },
      { ...STUB_SYMBOL, id: "stub3", logicalKey: "stub3", name: "stub3" },
    ];
    const clusters: Cluster[] = [
      { id: "cluster-1", name: "Auth", symbols: ["stub", "stub2"], confidence: 0.9, category: "authentication" },
      { id: "cluster-2", name: "Data", symbols: ["stub2", "stub3", "stub"], confidence: 0.8, category: "dataAccess" },
    ];
    const processes: Process[] = [
      {
        id: "proc-1", name: "Login", entryPoint: "stub",
        steps: [
          { order: 0, symbolId: "stub", description: "entry" },
          { order: 1, symbolId: "stub2", description: "next" },
        ],
        dataFlow: [],
      },
      {
        id: "proc-2", name: "Sync", entryPoint: "stub3",
        steps: [
          { order: 0, symbolId: "stub3", description: "start" },
          { order: 1, symbolId: "stub", description: "mid" },
          { order: 2, symbolId: "stub2", description: "end" },
        ],
        dataFlow: [],
      },
    ];
    const relationships: Relationship[] = [
      { id: "rel-1", source: "stub", target: "stub2", relType: "calls", metadata: {} },
      { id: "rel-2", source: "stub2", target: "stub3", relType: "calls", metadata: {} },
      {
        id: "dep-1", source: "stub", target: "ext:lodash", relType: "dependsOn",
        metadata: { packageName: "lodash", ecosystem: "npm" },
      },
    ];
    const extNodes = new Map<string, ExternalDependencyNode>([
      ["ext:lodash", { id: "ext:lodash", name: "lodash", aliases: ["lodash"], ecosystem: "npm" }],
    ]);
    const embeddings = symbols.map((s) => ({ symbolId: s.id, embedding: STUB_EMBEDDING, metadata: {} }));

    mockExtractAllSymbols.mockResolvedValue({ symbols, hints: [], skippedFiles: 0 });
    mockResolveReferences.mockReturnValue({ relationships, extNodes });
    mockClusterSymbols.mockResolvedValue(clusters);
    mockTraceProcesses.mockReturnValue(processes);
    mockBuildSearchIndex.mockResolvedValue({
      keywords: new Map(),
      symbolCount: symbols.length,
      embeddings,
      embeddingStats: { attempts: embeddings.length, successes: embeddings.length, failures: 0 },
    });

    try {
      const result = await runIndexingPipeline({
        sourcePath: ".", language: "typescript", verbose: true, adapter,
      });

      const expectedTotal = countPersistRows(
        embeddings.length, symbols, relationships, clusters, processes, extNodes,
      );

      // The sum of every row reported via the persist onRows path (vectors +
      // nodes + edges) equals the metrics totals, which the pipeline drives off
      // those same callbacks. If storeInDatabases and countPersistRows drift,
      // this assertion fails.
      const summedFromOnRows =
        result.metrics.vectorWrites +
        result.metrics.graphNodeWrites +
        result.metrics.graphEdgeWrites;
      expect(summedFromOnRows).toBe(expectedTotal);

      // Sanity: the fixture truly exercises CONTAINS (2 + 3 = 5) and HAS_STEP
      // (2 + 3 = 5) edges plus the 3 relationship edges → 13 edges total.
      expect(result.metrics.graphEdgeWrites).toBe(13);
      expect(result.metrics.graphNodeWrites).toBe(
        symbols.length + clusters.length + processes.length + extNodes.size,
      );
      expect(result.metrics.vectorWrites).toBe(embeddings.length);

      // The progress renderer's final reported value reaches the total (100%).
      const progressWrites = stderrSpy.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((chunk) => chunk.includes("Indexing into LadybugDB"));
      expect(progressWrites.length).toBeGreaterThan(0);
      const reached100 = progressWrites.some(
        (chunk) => chunk.includes(`${expectedTotal}/${expectedTotal}`) && chunk.includes("(100%)"),
      );
      expect(reached100).toBe(true);
    } finally {
      stderrSpy.mockRestore();
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
    }
  });
});

// ─── A4: diff-based persistence (delta write) ───────────────────────────────────
//
// These tests drive the pipeline's DELTA branch with a mock adapter that exposes
// the optional per-file deletes. They assert: (1) the delete fast-paths are
// called with the removed+changed file scopes; (2) only the changed+added file
// symbols/vectors are inserted (unchanged files are skipped); (3) the FULL
// relationship/cluster/process set is still written wholesale; (4) the lastIndexed
// Metadata node is written; (5) when the adapter LACKS the deletes, the pipeline
// silently falls back to a full INSERT (no delete, all symbols inserted).

describe("runIndexingPipeline — A4 diff-based persistence (delta branch)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  // Two files: a.ts (changed) and b.ts (unchanged). The merged set passed to
  // persist is global (both files' symbols), mirroring v1's global resolution.
  const symA: Symbol = {
    ...STUB_SYMBOL, id: "src/a.ts:Foo", logicalKey: "lk-foo", name: "Foo",
    location: { filePath: "src/a.ts", startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
  };
  const symB: Symbol = {
    ...STUB_SYMBOL, id: "src/b.ts:Bar", logicalKey: "lk-bar", name: "Bar",
    location: { filePath: "src/b.ts", startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
  };

  function primeTwoFileRun(): void {
    mockExtractAllSymbols.mockResolvedValue({ symbols: [symA, symB], hints: [], skippedFiles: 0 });
    // A cross-file edge b.ts → a.ts (an inbound edge to the changed file). The
    // DETACH DELETE drops it; the wholesale relationship rewrite restores it.
    mockResolveReferences.mockReturnValue({
      relationships: [{ id: "rel-1", source: symB.id, target: symA.id, relType: "calls", metadata: {} }],
      extNodes: new Map(),
    });
    mockBuildSearchIndex.mockResolvedValue({
      keywords: new Map(), symbolCount: 2,
      embeddings: [
        { symbolId: symA.id, embedding: STUB_EMBEDDING, metadata: { filePath: "src/a.ts" } },
        { symbolId: symB.id, embedding: STUB_EMBEDDING, metadata: { filePath: "src/b.ts" } },
      ],
      embeddingStats: { attempts: 2, successes: 2, failures: 0 },
    });
  }

  function makeDeltaCapableAdapter() {
    const base = makeMockAdapter(true);
    const deleteSymbolsByFilePaths = vi.fn().mockResolvedValue(1);
    const deleteByFilePaths = vi.fn().mockResolvedValue(1);
    (base.graph as GraphAdapter & { deleteSymbolsByFilePaths: typeof deleteSymbolsByFilePaths })
      .deleteSymbolsByFilePaths = deleteSymbolsByFilePaths;
    (base.vector as VectorAdapter & { deleteByFilePaths: typeof deleteByFilePaths })
      .deleteByFilePaths = deleteByFilePaths;
    return { ...base, deleteSymbolsByFilePaths, deleteByFilePaths };
  }

  it("deletes the removed+changed scopes and inserts only changed+added symbols/vectors", async () => {
    primeTwoFileRun();
    const { adapter, graph, vector, deleteSymbolsByFilePaths, deleteByFilePaths } =
      makeDeltaCapableAdapter();

    await runIndexingPipeline({
      sourcePath: ".", language: "typescript", verbose: false, adapter,
      delta: { removedAndChangedFiles: ["src/a.ts"], addedAndChangedFiles: ["src/a.ts"] },
    });

    // (1) per-file deletes called with the removed+changed scope.
    expect(deleteSymbolsByFilePaths).toHaveBeenCalledWith(["src/a.ts"]);
    expect(deleteByFilePaths).toHaveBeenCalledWith(["src/a.ts"]);

    // (2) only the changed file's Symbol node is inserted (b.ts skipped).
    const symbolNodeCalls = (graph.createNode as ReturnType<typeof vi.fn>).mock.calls
      .filter(([label]) => label === "Symbol");
    expect(symbolNodeCalls).toHaveLength(1);
    expect(symbolNodeCalls[0][1]).toMatchObject({ id: "lk-foo" });

    // only the changed file's vector is inserted.
    const vectorCalls = (vector.indexSymbol as ReturnType<typeof vi.fn>).mock.calls;
    expect(vectorCalls).toHaveLength(1);
    expect(vectorCalls[0][0]).toBe("lk-foo");

    // (3) the inbound cross-file edge (b.ts → a.ts) is STILL written wholesale,
    // restoring what the DETACH DELETE transiently dropped (keyed by logicalKey).
    expect(graph.createRelationship).toHaveBeenCalledWith("lk-bar", "lk-foo", "CALLS", {});

    // (4) lastIndexed Metadata node written.
    expect(graph.createNode).toHaveBeenCalledWith(
      "Metadata",
      expect.objectContaining({ key: "lastIndexed" }),
    );
  });

  it("falls back to a full INSERT (no delete) when the adapter lacks per-file deletes", async () => {
    primeTwoFileRun();
    const { adapter, graph, vector } = makeMockAdapter(true); // no delete fast-paths

    await runIndexingPipeline({
      sourcePath: ".", language: "typescript", verbose: false, adapter,
      delta: { removedAndChangedFiles: ["src/a.ts"], addedAndChangedFiles: ["src/a.ts"] },
    });

    // Both files' symbols + vectors inserted (delta inactive → full insert).
    const symbolNodeCalls = (graph.createNode as ReturnType<typeof vi.fn>).mock.calls
      .filter(([label]) => label === "Symbol");
    expect(symbolNodeCalls).toHaveLength(2);
    expect((vector.indexSymbol as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("counts only the inserted subset for the persist progress total (delta drift-guard)", async () => {
    primeTwoFileRun();
    const { adapter } = makeDeltaCapableAdapter();

    const result = await runIndexingPipeline({
      sourcePath: ".", language: "typescript", verbose: false, adapter,
      delta: { removedAndChangedFiles: ["src/a.ts"], addedAndChangedFiles: ["src/a.ts"] },
    });

    // Inserted: 1 symbol node + 1 vector + 1 relationship edge (wholesale).
    // countPersistRows is computed on the INSERTED subset for symbols/vectors but
    // the FULL set for relationships — assert the metric totals match that shape.
    expect(result.metrics.graphNodeWrites).toBe(1); // only lk-foo (b.ts skipped)
    expect(result.metrics.vectorWrites).toBe(1);
    expect(result.metrics.graphEdgeWrites).toBe(1); // the wholesale CALLS edge
  });
});
