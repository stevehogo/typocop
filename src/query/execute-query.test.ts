/**
 * Unit tests verifying all five query types work through the DatabaseAdapter.
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DatabaseAdapter, GraphAdapter, VectorAdapter, EmbeddingAdapter } from "../db/types.js";
import type { QueryResult, Embedding } from "../types/index.js";
import { executeQuery } from "./execute-query.js";

// ─── Mock modules ─────────────────────────────────────────────────────────────

vi.mock("./parse-intent.js", () => ({
  parseQueryIntent: vi.fn(),
}));

vi.mock("../security/sanitize.js", () => ({
  sanitizeQuery: vi.fn((q: string) => q),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockGraphAdapter(overrides?: Partial<GraphAdapter>): GraphAdapter {
  return {
    createNode: vi.fn(),
    createRelationship: vi.fn(),
    queryNodes: vi.fn(),
    queryRelationships: vi.fn(),
    deleteNodesByLabel: vi.fn(),
    deleteRelationshipsByType: vi.fn(),
    runCypher: vi.fn().mockResolvedValue([]),
    runCypherWrite: vi.fn(),
    ...overrides,
  };
}

function createMockVectorAdapter(overrides?: Partial<VectorAdapter>): VectorAdapter {
  return {
    createTables: vi.fn(),
    indexSymbol: vi.fn(),
    semanticSearch: vi.fn().mockResolvedValue([]),
    deleteAll: vi.fn(),
    ...overrides,
  };
}

function createMockEmbeddingAdapter(overrides?: Partial<EmbeddingAdapter>): EmbeddingAdapter {
  return {
    isEnabled: vi.fn().mockReturnValue(true),
    embedText: vi.fn().mockResolvedValue({ vector: [0.1, 0.2], dimensions: 2 }),
    getDimensions: vi.fn().mockReturnValue(2),
    ...overrides,
  };
}

function createMockDatabaseAdapter(opts?: {
  graph?: Partial<GraphAdapter>;
  vector?: Partial<VectorAdapter>;
  embedding?: Partial<EmbeddingAdapter>;
}): DatabaseAdapter {
  const graph = createMockGraphAdapter(opts?.graph);
  const vector = createMockVectorAdapter(opts?.vector);
  const embedding = createMockEmbeddingAdapter(opts?.embedding);
  return {
    initialize: vi.fn(),
    close: vi.fn(),
    getGraphAdapter: vi.fn().mockReturnValue(graph),
    getVectorAdapter: vi.fn().mockReturnValue(vector),
    getEmbeddingAdapter: vi.fn().mockReturnValue(embedding),
  };
}

const SYMBOL_NODE = {
  n: {
    labels: ["Symbol"],
    properties: {
      id: "sym-1",
      name: "myFunction",
      kind: "function",
      filePath: "/src/test.ts",
      startLine: "1",
      startColumn: "0",
      endLine: "10",
      endColumn: "0",
      visibility: "public",
    },
  },
};

const DEPENDENT_NODE = {
  n: {
    labels: ["Symbol"],
    properties: {
      id: "dep-1",
      name: "callerFn",
      kind: "function",
      filePath: "/src/caller.ts",
      startLine: "5",
      startColumn: "0",
      endLine: "15",
      endColumn: "0",
      visibility: "public",
    },
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("executeQuery — adapter-based routing (Req 7.1, 7.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("returns empty result for invalid query text", async () => {
    const { parseQueryIntent } = await import("./parse-intent.js");
    const adapter = createMockDatabaseAdapter();

    const result = await executeQuery({ text: "", maxResults: 10 }, adapter);

    expect(result.symbols).toEqual([]);
    expect(result.confidence).toBe(0.5);
    expect(parseQueryIntent).not.toHaveBeenCalled();
  });
});

describe("executeQuery — impactAnalysis (Req 7.2, 7.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes impactAnalysis through GraphAdapter.runCypher()", async () => {
    const { parseQueryIntent } = await import("./parse-intent.js");
    vi.mocked(parseQueryIntent).mockReturnValue({
      intent: { type: "impactAnalysis", target: "sym-1" },
      confidence: 0.9,
    });

    const runCypher = vi.fn()
      .mockResolvedValueOnce([SYMBOL_NODE])   // findNode
      .mockResolvedValueOnce([DEPENDENT_NODE]) // findDependents
      .mockResolvedValueOnce([])               // findProcessesBySymbol
      .mockResolvedValueOnce([]);              // findClustersBySymbol

    const adapter = createMockDatabaseAdapter({ graph: { runCypher } });

    const result = await executeQuery(
      { text: "impact of myFunction", maxResults: 10 },
      adapter,
    );

    expect(result.intent.type).toBe("impactAnalysis");
    expect(result.symbols.length).toBeGreaterThanOrEqual(1);
    expect(runCypher).toHaveBeenCalled();
  });

  it("returns empty result when target not found", async () => {
    const { parseQueryIntent } = await import("./parse-intent.js");
    vi.mocked(parseQueryIntent).mockReturnValue({
      intent: { type: "impactAnalysis", target: "nonexistent" },
      confidence: 0.9,
    });

    const runCypher = vi.fn().mockResolvedValue([]);
    const adapter = createMockDatabaseAdapter({ graph: { runCypher } });

    const result = await executeQuery(
      { text: "impact of nonexistent", maxResults: 10 },
      adapter,
    );

    expect(result.symbols).toEqual([]);
    expect(result.confidence).toBe(0.5);
  });
});

describe("executeQuery — contextRetrieval (Req 7.2, 7.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes contextRetrieval through GraphAdapter.runCypher()", async () => {
    const { parseQueryIntent } = await import("./parse-intent.js");
    vi.mocked(parseQueryIntent).mockReturnValue({
      intent: { type: "contextRetrieval", target: "sym-1" },
      confidence: 0.9,
    });

    const runCypher = vi.fn()
      .mockResolvedValueOnce([SYMBOL_NODE])   // findNode
      .mockResolvedValueOnce([DEPENDENT_NODE]) // findDependents
      .mockResolvedValueOnce([])               // findDependencies
      .mockResolvedValueOnce([])               // findProcessesBySymbol
      .mockResolvedValueOnce([]);              // findClustersBySymbol

    const adapter = createMockDatabaseAdapter({ graph: { runCypher } });

    const result = await executeQuery(
      { text: "context of sym-1", maxResults: 10 },
      adapter,
    );

    expect(result.intent.type).toBe("contextRetrieval");
    expect(result.symbols.length).toBeGreaterThanOrEqual(1);
    expect(runCypher).toHaveBeenCalled();
  });
});

describe("executeQuery — dataFlowTrace (Req 7.2, 7.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes dataFlowTrace through GraphAdapter.runCypher()", async () => {
    const { parseQueryIntent } = await import("./parse-intent.js");
    vi.mocked(parseQueryIntent).mockReturnValue({
      intent: { type: "dataFlowTrace", entryPoint: "sym-1" },
      confidence: 0.9,
    });

    const runCypher = vi.fn()
      .mockResolvedValueOnce([SYMBOL_NODE]) // findNode
      .mockResolvedValueOnce([]);           // findDependencies

    const adapter = createMockDatabaseAdapter({ graph: { runCypher } });

    const result = await executeQuery(
      { text: "trace data flow from sym-1", maxResults: 10 },
      adapter,
    );

    expect(result.intent.type).toBe("dataFlowTrace");
    expect(result.symbols.length).toBeGreaterThanOrEqual(1);
    expect(runCypher).toHaveBeenCalled();
  });

  it("returns empty result when entry point not found", async () => {
    const { parseQueryIntent } = await import("./parse-intent.js");
    vi.mocked(parseQueryIntent).mockReturnValue({
      intent: { type: "dataFlowTrace", entryPoint: "missing" },
      confidence: 0.9,
    });

    const runCypher = vi.fn().mockResolvedValue([]);
    const adapter = createMockDatabaseAdapter({ graph: { runCypher } });

    const result = await executeQuery(
      { text: "trace data flow from missing", maxResults: 10 },
      adapter,
    );

    expect(result.symbols).toEqual([]);
    expect(result.confidence).toBe(0.5);
  });
});

describe("executeQuery — preCommitCheck (Req 7.2, 7.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes preCommitCheck through GraphAdapter.runCypher()", async () => {
    const { parseQueryIntent } = await import("./parse-intent.js");
    vi.mocked(parseQueryIntent).mockReturnValue({
      intent: { type: "preCommitCheck", changedFiles: ["/src/test.ts"] },
      confidence: 0.9,
    });

    const symbolRow = {
      s: {
        labels: ["Symbol"],
        properties: {
          id: "sym-1",
          name: "myFunction",
          kind: "function",
          filePath: "/src/test.ts",
          startLine: "1",
          startColumn: "0",
          endLine: "10",
          endColumn: "0",
          visibility: "public",
        },
      },
    };

    const runCypher = vi.fn()
      .mockResolvedValueOnce([symbolRow]) // findSymbolsInFiles
      .mockResolvedValueOnce([])          // findDependents for sym-1
      .mockResolvedValueOnce([])          // findProcessesBySymbol for sym-1
      .mockResolvedValueOnce([]);         // findClustersBySymbol for sym-1

    const adapter = createMockDatabaseAdapter({ graph: { runCypher } });

    const result = await executeQuery(
      { text: "pre-commit check /src/test.ts", maxResults: 10 },
      adapter,
    );

    expect(result.intent.type).toBe("preCommitCheck");
    expect(result.symbols.length).toBeGreaterThanOrEqual(1);
    expect(runCypher).toHaveBeenCalled();
  });

  it("returns empty result when no symbols in changed files", async () => {
    const { parseQueryIntent } = await import("./parse-intent.js");
    vi.mocked(parseQueryIntent).mockReturnValue({
      intent: { type: "preCommitCheck", changedFiles: ["/src/empty.ts"] },
      confidence: 0.9,
    });

    const runCypher = vi.fn().mockResolvedValue([]);
    const adapter = createMockDatabaseAdapter({ graph: { runCypher } });

    const result = await executeQuery(
      { text: "pre-commit check /src/empty.ts", maxResults: 10 },
      adapter,
    );

    expect(result.symbols).toEqual([]);
    expect(result.confidence).toBe(0.95);
  });
});

describe("executeQuery — smartSearch (Req 7.3, 7.4, 7.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes smartSearch through VectorAdapter and EmbeddingAdapter when enabled (Req 7.3)", async () => {
    const { parseQueryIntent } = await import("./parse-intent.js");
    vi.mocked(parseQueryIntent).mockReturnValue({
      intent: { type: "smartSearch", query: "authentication" },
      confidence: 0.9,
    });

    const embedding: Embedding = { vector: [0.1, 0.2, 0.3], dimensions: 3 };
    const searchResults = [
      { symbolId: "sym-1", score: 0.95, metadata: {} },
    ];

    const semanticSearch = vi.fn().mockResolvedValue(searchResults);
    const embedText = vi.fn().mockResolvedValue(embedding);
    const isEnabled = vi.fn().mockReturnValue(true);

    const runCypher = vi.fn()
      .mockResolvedValueOnce([{  // fetchSymbols
        id: "sym-1", name: "authService", kind: "function",
        filePath: "/src/auth.ts", startLine: "1", startColumn: "0",
        endLine: "10", endColumn: "0", signature: undefined,
        documentation: undefined, visibility: "public", modifiers: [],
      }])
      .mockResolvedValueOnce([]) // fetchClustersForSymbols
      .mockResolvedValueOnce([]); // fetchProcessesForSymbols

    const adapter = createMockDatabaseAdapter({
      graph: { runCypher },
      vector: { semanticSearch },
      embedding: { isEnabled, embedText },
    });

    const result = await executeQuery(
      { text: "find authentication", maxResults: 10 },
      adapter,
    );

    expect(result.intent.type).toBe("smartSearch");
    expect(embedText).toHaveBeenCalled();
    expect(semanticSearch).toHaveBeenCalledWith(embedding, 20); // maxResults * 2
  });

  it("returns empty results when embeddings are disabled (Req 7.4)", async () => {
    const { parseQueryIntent } = await import("./parse-intent.js");
    vi.mocked(parseQueryIntent).mockReturnValue({
      intent: { type: "smartSearch", query: "authentication" },
      confidence: 0.9,
    });

    const isEnabled = vi.fn().mockReturnValue(false);
    const embedText = vi.fn();
    const semanticSearch = vi.fn();

    const adapter = createMockDatabaseAdapter({
      embedding: { isEnabled, embedText },
      vector: { semanticSearch },
    });

    const result = await executeQuery(
      { text: "find authentication", maxResults: 10 },
      adapter,
    );

    expect(result.intent.type).toBe("smartSearch");
    expect(result.symbols).toEqual([]);
    expect(embedText).not.toHaveBeenCalled();
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it("returns empty results when embedText returns null", async () => {
    const { parseQueryIntent } = await import("./parse-intent.js");
    vi.mocked(parseQueryIntent).mockReturnValue({
      intent: { type: "smartSearch", query: "something" },
      confidence: 0.9,
    });

    const isEnabled = vi.fn().mockReturnValue(true);
    const embedText = vi.fn().mockResolvedValue(null);
    const semanticSearch = vi.fn();

    const adapter = createMockDatabaseAdapter({
      embedding: { isEnabled, embedText },
      vector: { semanticSearch },
    });

    const result = await executeQuery(
      { text: "find something", maxResults: 10 },
      adapter,
    );

    expect(result.symbols).toEqual([]);
    expect(semanticSearch).not.toHaveBeenCalled();
  });
});
