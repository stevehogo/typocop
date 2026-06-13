/**
 * Property tests for query execution.
 *
 * Property 9: Query Result Limit
 *   executeQuery must return at most maxResults symbols.
 *   Validates: Requirement 9.6
 *
 * Property 10: Query Confidence Bounds
 *   Confidence score must be in [0.0, 1.0].
 *   Validates: Requirements 9.4, 21.2
 *
 * Property 11: High Confidence Completeness
 *   When confidence >= 0.90, at least one symbol must be returned.
 *   Validates: Requirements 9.7, 21.3, 21.4
 */
import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { parseQueryIntent } from "./parse-intent.js";
import { executeQuery } from "./execute-query.js";
import { formatResponse } from "./format-response.js";
import { calculateConfidence } from "./confidence.js";
import type { Query, QueryResult, Symbol, Relationship, QueryIntent } from "../core/domain.js";
import type { DatabaseAdapter, GraphAdapter, VectorAdapter, EmbeddingAdapter } from "../core/ports/persistence.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockDatabaseAdapter(): DatabaseAdapter {
  const graph: GraphAdapter = {
    createNode: vi.fn(),
    createRelationship: vi.fn(),
    queryNodes: vi.fn(),
    queryRelationships: vi.fn(),
    deleteNodesByLabel: vi.fn(),
    deleteRelationshipsByType: vi.fn(),
    runCypher: vi.fn().mockResolvedValue([]),
    runCypherWrite: vi.fn(),
  };
  const vector: VectorAdapter = {
    createTables: vi.fn(),
    indexSymbol: vi.fn(),
    semanticSearch: vi.fn().mockResolvedValue([]),
    deleteAll: vi.fn(),
  };
  const embedding: EmbeddingAdapter = {
    isEnabled: vi.fn().mockReturnValue(false),
    embedText: vi.fn().mockResolvedValue(null),
    getDimensions: vi.fn().mockReturnValue(2560),
  };
  return {
    initialize: vi.fn(),
    close: vi.fn(),
    getGraphAdapter: vi.fn().mockReturnValue(graph),
    getVectorAdapter: vi.fn().mockReturnValue(vector),
    getEmbeddingAdapter: vi.fn().mockReturnValue(embedding),
  };
}

// ─── Property 9: Query Result Limit ──────────────────────────────────────────

describe("executeQuery (Property 9: Result Limit)", () => {
  it("Property 9: returns at most maxResults symbols", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        fc.integer({ min: 1, max: 100 }),
        async (text, maxResults) => {
          const query: Query = { text, maxResults };
          const adapter = mockDatabaseAdapter();
          const result = await executeQuery(query, adapter);
          return result.symbols.length <= maxResults;
        },
      ),
    );
  });

  it("respects maxResults=1", async () => {
    const query: Query = { text: "find user functions", maxResults: 1 };
    const result = await executeQuery(query, mockDatabaseAdapter());
    expect(result.symbols.length).toBeLessThanOrEqual(1);
  });
});

// ─── Property 10: Confidence Bounds ──────────────────────────────────────────

describe("executeQuery (Property 10: Confidence Bounds)", () => {
  it("Property 10: confidence is always in [0.0, 1.0]", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), async (text) => {
        const query: Query = { text, maxResults: 10 };
        const adapter = mockDatabaseAdapter();
        const result = await executeQuery(query, adapter);
        return result.confidence >= 0.0 && result.confidence <= 1.0;
      }),
    );
  });

  it("returns confidence in valid range for any query", async () => {
    const queries = [
      "what breaks if I change getUserById",
      "find payment logic",
      "who calls authenticate",
    ];

    for (const text of queries) {
      const result = await executeQuery({ text, maxResults: 10 }, mockDatabaseAdapter());
      expect(result.confidence).toBeGreaterThanOrEqual(0.0);
      expect(result.confidence).toBeLessThanOrEqual(1.0);
    }
  });
});

// ─── Property 11: High Confidence Completeness ───────────────────────────────

describe("executeQuery (Property 11: High Confidence Completeness)", () => {
  it("Property 11: confidence >= 0.90 implies at least one symbol returned", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), async (text) => {
        const query: Query = { text, maxResults: 10 };
        const adapter = mockDatabaseAdapter();
        const result = await executeQuery(query, adapter);

        if (result.symbols.length === 0) {
          return result.confidence < 0.90;
        }
        return true;
      }),
    );
  });
});

// ─── calculateConfidence unit tests ──────────────────────────────────────────

describe("calculateConfidence", () => {
  const intent: QueryIntent = { type: "smartSearch", query: "test" };

  const makeSymbol = (): Symbol => ({
    id: "s1", name: "foo", kind: "function",
    location: { filePath: "a.ts", startLine: 1, startColumn: 0, endLine: 5, endColumn: 0 },
    visibility: "public", modifiers: [],
  });

  it("returns 0.5 when no symbols found", () => {
    expect(calculateConfidence([], [], intent)).toBe(0.5);
    expect(calculateConfidence([], [], intent, [{ score: 0.95 }])).toBe(0.5);
  });

  it("uses average similarity score when search results provided", () => {
    const symbols = [makeSymbol()];
    const score = calculateConfidence(symbols, [], intent, [
      { score: 0.95 },
      { score: 0.85 },
    ]);
    expect(score).toBeCloseTo(0.90, 5);
  });

  it("adds structural bonus when relationships present", () => {
    const symbols = [makeSymbol()];
    const rel: Relationship = {
      id: "r1", source: "s1", target: "s2", relType: "calls", metadata: {},
    };
    const score = calculateConfidence(symbols, [rel], intent, [{ score: 0.90 }]);
    expect(score).toBeCloseTo(0.95, 5);
  });

  it("caps confidence at 1.0", () => {
    const symbols = [makeSymbol()];
    const rel: Relationship = {
      id: "r1", source: "s1", target: "s2", relType: "calls", metadata: {},
    };
    const score = calculateConfidence(symbols, [rel], intent, [{ score: 0.99 }]);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it("falls back to count-based heuristic without search results", () => {
    const symbols = [makeSymbol()];
    const rel: Relationship = {
      id: "r1", source: "s1", target: "s2", relType: "calls", metadata: {},
    };
    expect(calculateConfidence(symbols, [rel], intent)).toBe(0.92);
    expect(calculateConfidence(symbols, [], intent)).toBe(0.75);
  });
});

// ─── parseQueryIntent ─────────────────────────────────────────────────────────

describe("parseQueryIntent", () => {
  it("returns intent with confidence >= 0.7", () => {
    const { intent, confidence } = parseQueryIntent("what breaks if I change getUserById");
    expect(intent.type).toBe("impactAnalysis");
    expect(confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("handles all intent types", () => {
    const cases = [
      { text: "impact of changing foo", expectedType: "impactAnalysis" },
      { text: "find payment logic", expectedType: "smartSearch" },
      { text: "who calls authenticate", expectedType: "contextRetrieval" },
      { text: "trace data flow from /api/users", expectedType: "dataFlowTrace" },
    ];

    for (const { text, expectedType } of cases) {
      const { intent, confidence } = parseQueryIntent(text);
      expect(intent.type).toBe(expectedType);
      expect(confidence).toBeGreaterThanOrEqual(0.7);
    }
  });
});

// ─── formatResponse ───────────────────────────────────────────────────────────

describe("formatResponse", () => {
  it("formats a minimal result", () => {
    const result: QueryResult = {
      intent: { type: "smartSearch", query: "test" },
      symbols: [],
      relationships: [],
      clusters: [],
      processes: [],
      confidence: 0.85,
      riskLevel: "low",
      affectedFlows: [],
    };

    const formatted = formatResponse(result);
    expect(formatted).toContain("Intent: smartSearch");
    expect(formatted).toContain("Confidence: 85.0%");
    expect(formatted).toContain("Risk Level: LOW");
  });

  it("formats a result with symbols", () => {
    const result: QueryResult = {
      intent: { type: "impactAnalysis", target: "foo" },
      symbols: [
        {
          id: "1", name: "getUserById", kind: "function",
          location: { filePath: "user.ts", startLine: 10, startColumn: 0, endLine: 20, endColumn: 0 },
          visibility: "public", modifiers: [],
        },
      ],
      relationships: [],
      clusters: [],
      processes: [],
      confidence: 0.92,
      riskLevel: "low",
      affectedFlows: [],
    };

    const formatted = formatResponse(result);
    expect(formatted).toContain("getUserById");
    expect(formatted).toContain("user.ts:10");
  });
});
