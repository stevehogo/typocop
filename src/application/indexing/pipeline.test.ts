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
import type { Symbol, Cluster, Process, Relationship, Embedding } from "../../core/domain.js";
import type { DatabaseAdapter, GraphAdapter, VectorAdapter, EmbeddingAdapter } from "../../core/ports/persistence.js";

// ─── Stub data ────────────────────────────────────────────────────────────────

const STUB_SYMBOL: Symbol = {
  id: "stub",
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
  mockBuildSearchIndex,
} = vi.hoisted(() => ({
  mockWalkFileTree: vi.fn(),
  mockExtractAllSymbols: vi.fn(),
  mockResolveReferences: vi.fn(),
  mockClusterSymbols: vi.fn(),
  mockTraceProcesses: vi.fn(),
  mockBuildSearchIndex: vi.fn(),
}));

vi.mock("./structure/index.js", () => ({ walkFileTree: mockWalkFileTree }));
vi.mock("./parsing/index.js", () => ({ extractAllSymbols: mockExtractAllSymbols }));
vi.mock("./resolution/index.js", () => ({ resolveReferences: mockResolveReferences }));
vi.mock("./clustering/index.js", () => ({ clusterSymbols: mockClusterSymbols }));
vi.mock("./processes/index.js", () => ({ traceProcesses: mockTraceProcesses }));
vi.mock("./search/index.js", () => ({ buildSearchIndex: mockBuildSearchIndex }));
vi.mock("../../platform/config/index.js", () => ({
  configurationManager: { getPrefix: () => "tpc_" },
}));

// ─── Import under test ───────────────────────────────────────────────────────

import { runIndexingPipeline } from "./pipeline.js";

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
      symbols: [STUB_SYMBOL, { ...STUB_SYMBOL, id: "stub2", name: "stub2" }],
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

    // 2 symbols + 1 cluster + 1 process = 4 nodes
    expect(graph.createNode).toHaveBeenCalledTimes(4);
    // 1 relationship + 2 cluster membership + 2 process steps = 5 edges
    expect(graph.createRelationship).toHaveBeenCalledTimes(5);

    // Verify bare labels (adapter handles prefix internally)
    expect(graph.createNode).toHaveBeenCalledWith("Symbol", expect.objectContaining({ id: "stub" }));
    expect(graph.createNode).toHaveBeenCalledWith("Cluster", expect.objectContaining({ id: "cluster-1" }));
    expect(graph.createNode).toHaveBeenCalledWith("Process", expect.objectContaining({ id: "proc-1" }));

    // Verify bare edge types (adapter handles prefix internally)
    expect(graph.createRelationship).toHaveBeenCalledWith("stub", "stub2", "CALLS", {});
    expect(graph.createRelationship).toHaveBeenCalledWith("cluster-1", "stub", "CONTAINS", {});
    expect(graph.createRelationship).toHaveBeenCalledWith("proc-1", "stub", "HAS_STEP", { step_order: "0" });
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
      symbols: [STUB_SYMBOL, { ...STUB_SYMBOL, id: "stub2", name: "stub2" }],
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

    // Relationships grouped by type.
    const relTypes = (createRelationships.mock.calls as Array<[string, unknown[]]>).map(([t]) => t);
    expect(relTypes).toEqual(expect.arrayContaining(["CALLS", "CONTAINS", "HAS_STEP"]));

    // Vector entries batched.
    const vecBatches = indexSymbols.mock.calls as Array<[Array<unknown>]>;
    expect(vecBatches.flatMap(([part]) => part)).toHaveLength(2);

    // Metrics count ROWS, not batch calls.
    // 2 symbols + 1 cluster + 1 process = 4 node rows.
    expect(result.metrics.graphNodeWrites).toBe(4);
    // 1 CALLS + 2 CONTAINS + 2 HAS_STEP = 5 edge rows.
    expect(result.metrics.graphEdgeWrites).toBe(5);
    expect(result.metrics.vectorWrites).toBe(2);
    expect(result.embeddingCount).toBe(2);
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
