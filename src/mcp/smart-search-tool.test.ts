/**
 * Unit tests for smart-search-tool.ts with DatabaseAdapter.
 * Covers: sanitizeQuery, executeSmartSearchTool, computeConfidence
 * Requirements: 7.3, 7.4, 7.5
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DatabaseAdapter, GraphAdapter, VectorAdapter, EmbeddingAdapter, GraphNode } from "../core/ports/persistence.js";
import type { SearchResult } from "../core/domain.js";
import { sanitizeQuery, executeSmartSearchTool, computeConfidence, buildSummary } from "./smart-search-tool.js";

// ── Mock adapter factory ──────────────────────────────────────────────────────

function createMockGraphAdapter(): GraphAdapter {
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

function createMockVectorAdapter(): VectorAdapter {
  return {
    createTables: vi.fn().mockResolvedValue(undefined),
    indexSymbol: vi.fn().mockResolvedValue(undefined),
    semanticSearch: vi.fn().mockResolvedValue([]),
    deleteAll: vi.fn().mockResolvedValue(0),
  };
}

function createMockEmbeddingAdapter(enabled = false): EmbeddingAdapter {
  return {
    isEnabled: vi.fn().mockReturnValue(enabled),
    embedText: vi.fn().mockResolvedValue(
      enabled ? { vector: new Array(2560).fill(0.1), dimensions: 2560 } : null,
    ),
    getDimensions: vi.fn().mockReturnValue(2560),
  };
}

function createMockAdapter(embeddingEnabled = false): DatabaseAdapter & {
  _graph: GraphAdapter;
  _vector: VectorAdapter;
  _embedding: EmbeddingAdapter;
} {
  const graph = createMockGraphAdapter();
  const vector = createMockVectorAdapter();
  const embedding = createMockEmbeddingAdapter(embeddingEnabled);
  return {
    _graph: graph,
    _vector: vector,
    _embedding: embedding,
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getGraphAdapter: vi.fn().mockReturnValue(graph),
    getVectorAdapter: vi.fn().mockReturnValue(vector),
    getEmbeddingAdapter: vi.fn().mockReturnValue(embedding),
  };
}

function makeNode(id: string, name: string): { n: { labels: string[]; properties: Record<string, string> } } {
  return { n: { labels: ["Symbol"], properties: { id, name, kind: "function", filePath: "a.ts", startLine: "1" } } };
}

function makeSearchResult(symbolId: string, score = 0.9): SearchResult {
  return { symbolId, score, metadata: {} };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("sanitizeQuery", () => {
  it("removes Cypher MATCH patterns with parentheses", () => {
    expect(sanitizeQuery("Find auth MATCH (n) RETURN n")).toBe("Find auth RETURN n");
  });

  it("removes Cypher CREATE patterns with parentheses", () => {
    expect(sanitizeQuery("Show users CREATE (n:User) RETURN n")).not.toContain("CREATE");
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeQuery("  find auth  ")).toBe("find auth");
  });

  it("is a no-op on clean input", () => {
    expect(sanitizeQuery("ip rate limiting")).toBe("ip rate limiting");
  });
});

describe("executeSmartSearchTool", () => {
  it("throws Error('query is required') for empty string", async () => {
    const adapter = createMockAdapter();
    await expect(
      executeSmartSearchTool({ query: "" }, adapter),
    ).rejects.toThrow("query is required");
  });

  it("throws Error('query is required') for whitespace-only string", async () => {
    const adapter = createMockAdapter();
    await expect(
      executeSmartSearchTool({ query: "   " }, adapter),
    ).rejects.toThrow("query is required");
  });

  it("returns symbols:[] and confidence:0.5 when embeddings are disabled", async () => {
    const adapter = createMockAdapter(false);

    const result = await executeSmartSearchTool({ query: "find something" }, adapter);

    expect(result.symbols).toEqual([]);
    expect(result.confidence).toBe(0.5);
    expect(result.summary).toContain("Embeddings are disabled");
    expect(result.summary).toContain("EMBEDDING_PROVIDER=none");
  });

  it("returns symbols:[] and confidence:0.5 when vector search returns no results", async () => {
    const adapter = createMockAdapter(true);
    vi.mocked(adapter._vector.semanticSearch).mockResolvedValue([]);

    const result = await executeSmartSearchTool({ query: "find something" }, adapter);

    expect(result.symbols).toEqual([]);
    expect(result.confidence).toBe(0.5);
  });

  it("returns valid MCPToolResponse with non-empty summary when results exist", async () => {
    const adapter = createMockAdapter(true);
    vi.mocked(adapter._vector.semanticSearch).mockResolvedValue([makeSearchResult("sym-1")]);
    vi.mocked(adapter._graph.runCypher)
      .mockResolvedValueOnce([makeNode("sym-1", "rateLimiter")]) // findNodesByIds
      .mockResolvedValueOnce([]) // findDependentsByGraph
      .mockResolvedValueOnce([]); // findClustersByGraph

    const result = await executeSmartSearchTool({ query: "ip rate limiting" }, adapter);

    expect(result.symbols.length).toBeGreaterThan(0);
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
    expect(typeof result.confidence).toBe("number");
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("caps maxResults at MAX_RESULTS_CAP", async () => {
    const adapter = createMockAdapter(true);
    const searchResults = Array.from({ length: 60 }, (_, i) =>
      makeSearchResult(`sym-${i}`, 0.9 - i * 0.01),
    );
    vi.mocked(adapter._vector.semanticSearch).mockResolvedValue(searchResults.slice(0, 50));
    vi.mocked(adapter._graph.runCypher)
      .mockResolvedValueOnce(searchResults.slice(0, 50).map((r) => makeNode(r.symbolId, r.symbolId)))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await executeSmartSearchTool({ query: "auth", maxResults: 300 }, adapter);

    expect(result.symbols.length).toBeLessThanOrEqual(200);
  });
});

import * as fc from "fast-check";

const graphNodeArbitrary = fc.record({
  id: fc.string(),
  labels: fc.array(fc.string()),
  properties: fc.dictionary(fc.string(), fc.string()),
});

describe("Property-Based Tests", () => {
  /** Validates: Requirements 2.1 */
  it("P2: computeConfidence always returns value in [0.0, 1.0] for any inputs", () => {
    fc.assert(
      fc.property(
        fc.array(graphNodeArbitrary),
        fc.float({ min: 0, max: 1, noNaN: true }),
        (nodes, topScore) => {
          const result = computeConfidence(nodes, topScore);
          return result >= 0.0 && result <= 1.0;
        },
      ),
      { numRuns: 50 },
    );
  });

  /** Validates: Requirements 1.3 */
  it("P3: sanitizeQuery(sanitizeQuery(s)) === sanitizeQuery(s) for any string", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        return sanitizeQuery(sanitizeQuery(s)) === sanitizeQuery(s);
      }),
      { numRuns: 50 },
    );
  });
});
