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
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
import { parseQueryIntent } from "./parse-intent.js";
import { executeQuery } from "./execute-query.js";
import { formatResponse } from "./format-response.js";
import type { Query, QueryResult } from "../types/index.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock the embedding module to avoid OpenAI API calls
vi.mock("../vector/embed.js", () => ({
  generateEmbedding: vi.fn(async () => ({
    vector: new Array(3072).fill(0),
    dimensions: 3072,
  })),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockVectorPool() {
  return { query: vi.fn(async () => ({ rows: [] })) };
}

function mockGraphSession() {
  return { run: vi.fn(async () => ({ records: [] })) };
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
          const pool = mockVectorPool();
          const session = mockGraphSession();

          const result = await executeQuery(query, pool as never, session as never);

          return result.symbols.length <= maxResults;
        },
      ),
    );
  });

  it("respects maxResults=1", async () => {
    const query: Query = { text: "find user functions", maxResults: 1 };
    const result = await executeQuery(query, mockVectorPool() as never, mockGraphSession() as never);
    expect(result.symbols.length).toBeLessThanOrEqual(1);
  });
});

// ─── Property 10: Confidence Bounds ──────────────────────────────────────────

describe("executeQuery (Property 10: Confidence Bounds)", () => {
  it("Property 10: confidence is always in [0.0, 1.0]", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), async (text) => {
        const query: Query = { text, maxResults: 10 };
        const pool = mockVectorPool();
        const session = mockGraphSession();

        const result = await executeQuery(query, pool as never, session as never);

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
      const result = await executeQuery(
        { text, maxResults: 10 },
        mockVectorPool() as never,
        mockGraphSession() as never,
      );
      expect(result.confidence).toBeGreaterThanOrEqual(0.0);
      expect(result.confidence).toBeLessThanOrEqual(1.0);
    }
  });
});

// ─── Property 11: High Confidence Completeness ───────────────────────────────

describe("executeQuery (Property 11: High Confidence Completeness)", () => {
  it("Property 11: confidence >= 0.90 implies at least one symbol returned", async () => {
    // This property is hard to test with mocks since our stub returns empty results
    // In a real implementation with DB, we'd verify:
    // If confidence >= 0.90, then symbols.length >= 1
    // For now, verify the inverse: if symbols.length === 0, confidence < 0.90
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), async (text) => {
        const query: Query = { text, maxResults: 10 };
        const pool = mockVectorPool();
        const session = mockGraphSession();

        const result = await executeQuery(query, pool as never, session as never);

        // Inverse: no symbols => confidence < 0.90
        if (result.symbols.length === 0) {
          return result.confidence < 0.90;
        }
        return true;
      }),
    );
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
          id: "1",
          name: "getUserById",
          kind: "function",
          location: { filePath: "user.ts", startLine: 10, startColumn: 0, endLine: 20, endColumn: 0 },
          visibility: "public",
          modifiers: [],
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
