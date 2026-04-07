/**
 * Unit tests for smart-search-tool.ts
 * Covers: sanitizeQuery, executeSmartSearchTool (4.1–4.5)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SearchResult } from "../types/index.js";
import type { GraphNode } from "../graph/connection.js";

// ── Module-level mocks ────────────────────────────────────────────────────────

vi.mock("../vector/embed.js", () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock("../vector/search.js", () => ({
  semanticSearch: vi.fn(),
}));

vi.mock("../graph/query.js", () => ({
  txFindNode: vi.fn(),
  txFindDependents: vi.fn(),
  txFindClustersBySymbol: vi.fn(),
}));

import { generateEmbedding } from "../vector/embed.js";
import { semanticSearch } from "../vector/search.js";
import { txFindNode, txFindDependents, txFindClustersBySymbol } from "../graph/query.js";
import { sanitizeQuery, executeSmartSearchTool } from "./smart-search-tool.js";
import { configurationManager } from "../config/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const FAKE_EMBEDDING = new Array(1536).fill(0.1);

function makeNode(id: string, name: string): GraphNode {
  return { id, labels: ["Symbol"], properties: { name, kind: "function", filePath: "a.ts", startLine: "1" } };
}

function makeSearchResult(symbolId: string, score = 0.9): SearchResult {
  return { symbolId, score, metadata: {} };
}

function makeMockSession() {
  return {
    executeRead: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockSessionManager(session: ReturnType<typeof makeMockSession>) {
  return {
    acquire: vi.fn().mockResolvedValue(session),
    release: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockDriver() {
  return {} as never;
}

function makeMockPool() {
  return {} as never;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("sanitizeQuery", () => {
  it("removes Cypher MATCH patterns with parentheses", () => {
    // 4.1
    expect(sanitizeQuery("Find auth MATCH (n) RETURN n")).toBe("Find auth RETURN n");
  });

  it("removes Cypher CREATE patterns with parentheses", () => {
    // 4.1
    expect(sanitizeQuery("Show users CREATE (n:User) RETURN n")).not.toContain("CREATE");
  });

  it("trims leading and trailing whitespace", () => {
    // 4.1
    expect(sanitizeQuery("  find auth  ")).toBe("find auth");
  });

  it("is a no-op on clean input", () => {
    expect(sanitizeQuery("ip rate limiting")).toBe("ip rate limiting");
  });
});

describe("executeSmartSearchTool", () => {
  beforeEach(async () => {
    delete process.env["TYPOCOP_PREFIX"];
    await configurationManager.initialize();
    vi.mocked(generateEmbedding).mockResolvedValue(FAKE_EMBEDDING);
    vi.mocked(txFindDependents).mockResolvedValue([]);
    vi.mocked(txFindClustersBySymbol).mockResolvedValue([]);
  });

  // 4.3 — empty / whitespace-only query
  it("throws Error('query is required') for empty string", async () => {
    const sm = makeMockSessionManager(makeMockSession());
    await expect(
      executeSmartSearchTool({ query: "" }, makeMockPool(), makeMockDriver(), sm as never),
    ).rejects.toThrow("query is required");
  });

  it("throws Error('query is required') for whitespace-only string", async () => {
    const sm = makeMockSessionManager(makeMockSession());
    await expect(
      executeSmartSearchTool({ query: "   " }, makeMockPool(), makeMockDriver(), sm as never),
    ).rejects.toThrow("query is required");
  });

  // 4.4 — zero pgvector results
  it("returns symbols:[] and confidence:0.5 when pgvector returns no results", async () => {
    vi.mocked(semanticSearch).mockResolvedValue([]);
    const sm = makeMockSessionManager(makeMockSession());

    const result = await executeSmartSearchTool(
      { query: "find something" },
      makeMockPool(),
      makeMockDriver(),
      sm as never,
    );

    expect(result.symbols).toEqual([]);
    expect(result.confidence).toBe(0.5);
  });

  // 4.2 — valid MCPToolResponse with non-empty summary
  it("returns valid MCPToolResponse with non-empty summary when results exist", async () => {
    const node = makeNode("sym-1", "rateLimiter");
    vi.mocked(semanticSearch).mockResolvedValue([makeSearchResult("sym-1")]);
    vi.mocked(txFindNode).mockResolvedValue(node);

    const session = makeMockSession();
    // First executeRead returns resolved nodes; second returns [dependents, clusters]
    session.executeRead
      .mockResolvedValueOnce([node])
      .mockResolvedValueOnce([[], []]);
    const sm = makeMockSessionManager(session);

    const result = await executeSmartSearchTool(
      { query: "ip rate limiting" },
      makeMockPool(),
      makeMockDriver(),
      sm as never,
    );

    expect(result.symbols.length).toBeGreaterThan(0);
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
    expect(typeof result.confidence).toBe("number");
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  // 4.5 — maxResults cap at 50
  it("caps maxResults at 50 even when 100 is passed", async () => {
    // Build 60 fake search results
    const searchResults = Array.from({ length: 60 }, (_, i) =>
      makeSearchResult(`sym-${i}`, 0.9 - i * 0.01),
    );
    vi.mocked(semanticSearch).mockImplementation(async (_pool, _emb, limit) => {
      return searchResults.slice(0, limit);
    });
    vi.mocked(txFindNode).mockImplementation(async (_tx, id) => makeNode(id, id));

    const session = makeMockSession();
    session.executeRead
      .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        // Simulate resolving up to 50 nodes
        const nodes = searchResults.slice(0, 50).map((r) => makeNode(r.symbolId, r.symbolId));
        return nodes;
      })
      .mockResolvedValueOnce([[], []]);
    const sm = makeMockSessionManager(session);

    const result = await executeSmartSearchTool(
      { query: "auth", maxResults: 100 },
      makeMockPool(),
      makeMockDriver(),
      sm as never,
    );

    expect(result.symbols.length).toBeLessThanOrEqual(50);
  });
});

import * as fc from "fast-check";
import { computeConfidence } from "./smart-search-tool.js";

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

  /** Validates: Requirements 1.7 */
  it("P6: response.symbols.length <= maxResults for any maxResults in [1, 50]", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 50 }), async (n) => {
        const fakeResults = Array.from({ length: n }, (_, i) =>
          makeSearchResult(`sym-${i}`, 0.9 - i * 0.001),
        );
        const fakeNodes = fakeResults.map((r) => makeNode(r.symbolId, r.symbolId));

        vi.mocked(generateEmbedding).mockResolvedValue(FAKE_EMBEDDING);
        vi.mocked(semanticSearch).mockResolvedValue(fakeResults);
        vi.mocked(txFindDependents).mockResolvedValue([]);
        vi.mocked(txFindClustersBySymbol).mockResolvedValue([]);

        const session = makeMockSession();
        session.executeRead
          .mockResolvedValueOnce(fakeNodes)
          .mockResolvedValueOnce([[], []]);
        const sm = makeMockSessionManager(session);

        const resp = await executeSmartSearchTool(
          { query: "test query", maxResults: n },
          makeMockPool(),
          makeMockDriver(),
          sm as never,
        );

        return resp.symbols.length <= n;
      }),
      { numRuns: 50 },
    );
  });
});