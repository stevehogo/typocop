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
  mockBuildSearchIndex.mockResolvedValue({ keywords: new Map(), symbolCount: 1, embeddings: [] });
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
      return { keywords: new Map(), symbolCount: 1, embeddings: [] };
    });

    await runIndexingPipeline({ sourcePath: ".", language: "typescript", verbose: false, adapter });

    expect(embedding.embedText).toHaveBeenCalledWith("test text");
  });

  it("should skip embeddings when EmbeddingAdapter.isEnabled() is false (Req 8.3)", async () => {
    const { adapter, embedding } = makeMockAdapter(false);

    mockBuildSearchIndex.mockImplementation(async (_s: unknown, _c: unknown, embedFn: unknown) => {
      expect(embedFn).toBeNull();
      return { keywords: new Map(), symbolCount: 1, embeddings: [] };
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
});
