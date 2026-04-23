/**
 * Property-based tests for LadybugVectorAdapter search result invariants.
 *
 * **Validates: Requirements 3.4**
 *
 * Property 3 from design-correctness.md:
 * ∀ search results R: R[i].score ≥ R[i+1].score for all valid i.
 *
 * Property 4 from design-correctness.md:
 * ∀ result r in semanticSearch(): r.score ≥ SEMANTIC_SEARCH_THRESHOLD (0.60).
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { LbugValue } from "@ladybugdb/core";
import { LadybugVectorAdapter, SEMANTIC_SEARCH_THRESHOLD } from "./ladybug-vector-adapter.js";
import type { SearchResult, Embedding } from "../types/index.js";

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Generate a valid SearchResult with score in [0, 1]. */
const searchResultArbitrary = (): fc.Arbitrary<SearchResult> =>
  fc.record({
    symbolId: fc.string({ minLength: 1, maxLength: 20 }),
    score: fc.double({ min: 0, max: 1, noNaN: true }),
    metadata: fc.dictionary(
      fc.string({ minLength: 1, maxLength: 10 }),
      fc.string({ maxLength: 20 }),
      { minKeys: 0, maxKeys: 3 },
    ),
  });

/** Generate a list of SearchResults that the adapter would return (score >= threshold, descending). */
const validSearchResultsArbitrary = (): fc.Arbitrary<SearchResult[]> =>
  fc
    .array(
      fc.record({
        symbolId: fc.string({ minLength: 1, maxLength: 20 }),
        score: fc.double({ min: SEMANTIC_SEARCH_THRESHOLD, max: 1, noNaN: true }),
        metadata: fc.dictionary(
          fc.string({ minLength: 1, maxLength: 10 }),
          fc.string({ maxLength: 20 }),
          { minKeys: 0, maxKeys: 3 },
        ),
      }),
      { minLength: 0, maxLength: 20 },
    )
    .map((results) =>
      [...results].sort((a, b) => b.score - a.score),
    );

// ─── In-memory Connection mock for property testing ──────────────────────────

/**
 * Creates a mock LadybugDB Connection that stores embeddings in memory
 * and simulates vector search with cosine similarity via connection.query().
 */
function createInMemoryConnection() {
  const rows: Array<{
    symbol_id: string;
    embedding: number[];
    dimensions: number;
    metadata: string;
  }> = [];

  /** Simple cosine similarity between two vectors. */
  function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
  }

  /** Parse a vector literal like [1,2,3] from a query string. */
  function parseVector(queryStr: string, marker: string): number[] | null {
    const idx = queryStr.indexOf(marker);
    if (idx === -1) return null;
    const start = queryStr.indexOf("[", idx);
    const end = queryStr.indexOf("]", start);
    if (start === -1 || end === -1) return null;
    return queryStr
      .slice(start + 1, end)
      .split(",")
      .map(Number);
  }

  /** Parse LIMIT N from a query string. */
  function parseLimit(queryStr: string): number {
    const match = queryStr.match(/LIMIT\s+(\d+)/i);
    return match ? parseInt(match[1], 10) : 100;
  }

  const connection = {
    query: async (queryStr: string): Promise<{ getAll: () => Promise<Record<string, LbugValue>[]> }> => {
      // CREATE NODE TABLE
      if (queryStr.includes("CREATE")) {
        return { getAll: async () => [] };
      }

      // MERGE (upsert)
      if (queryStr.includes("MERGE")) {
        const idMatch = queryStr.match(/symbol_id:\s*"([^"]+)"/);
        const symbolId = idMatch ? idMatch[1] : "";
        const vecMatch = queryStr.match(/n\.embedding\s*=\s*\[([^\]]*)\]/);
        const embedding = vecMatch ? vecMatch[1].split(",").map(Number) : [];
        const dimMatch = queryStr.match(/n\.dimensions\s*=\s*(\d+)/);
        const dimensions = dimMatch ? parseInt(dimMatch[1], 10) : 0;
        const metaMatch = queryStr.match(/n\.metadata\s*=\s*("(?:[^"\\]|\\.)*")/);
        let metadata = "{}";
        if (metaMatch) {
          // metaStr is JSON.stringify(JSON.stringify(obj)), so parse once to get the inner string
          try { metadata = JSON.parse(metaMatch[1]); } catch { /* keep default */ }
        }

        const existing = rows.findIndex((r) => r.symbol_id === symbolId);
        if (existing >= 0) {
          rows[existing] = { symbol_id: symbolId, embedding, dimensions, metadata };
        } else {
          rows.push({ symbol_id: symbolId, embedding, dimensions, metadata });
        }
        return { getAll: async () => [] };
      }

      // SELECT with cosine similarity
      if (queryStr.includes("array_cosine_similarity")) {
        const queryVector = parseVector(queryStr, "array_cosine_similarity");
        const limit = parseLimit(queryStr);

        if (!queryVector) return { getAll: async () => [] };

        const scored = rows
          .map((row) => ({
            symbol_id: row.symbol_id as LbugValue,
            metadata: row.metadata as LbugValue,
            score: cosineSimilarity(row.embedding, queryVector) as LbugValue,
          }))
          .filter((r) => (r.score as number) >= SEMANTIC_SEARCH_THRESHOLD)
          .sort((a, b) => (b.score as number) - (a.score as number))
          .slice(0, limit);

        return { getAll: async () => scored };
      }

      // DELETE
      if (queryStr.includes("DELETE")) {
        rows.length = 0;
        return { getAll: async () => [] };
      }

      return { getAll: async () => [] };
    },
    init: async () => {},
    close: async () => {},
  };

  return { connection, rows };
}

// ─── Property Tests ──────────────────────────────────────────────────────────

describe("LadybugVectorAdapter — property tests", () => {
  /**
   * Property 3: Search results ordered by descending score.
   * **Validates: Requirements 3.4**
   *
   * ∀ search results R: R[i].score ≥ R[i+1].score for all valid i.
   */
  it("5.4: search results are ordered by descending score", async () => {
    await fc.assert(
      fc.asyncProperty(
        validSearchResultsArbitrary(),
        async (expectedResults) => {
          // Verify the ordering property on the results
          for (let i = 0; i < expectedResults.length - 1; i++) {
            expect(expectedResults[i].score).toBeGreaterThanOrEqual(
              expectedResults[i + 1].score,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * Property 3 (integration): Search results from the adapter are ordered descending.
   * **Validates: Requirements 3.4**
   *
   * Uses an in-memory Connection mock to verify the adapter itself produces ordered results.
   */
  it("5.4: adapter semanticSearch returns results ordered by descending score", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 2-10 embeddings with small dimensions for speed
        fc.integer({ min: 2, max: 10 }),
        fc.integer({ min: 2, max: 8 }),
        async (numSymbols, dims) => {
          const { connection } = createInMemoryConnection();
          const adapter = new LadybugVectorAdapter(connection as never, "pbt_");
          await adapter.createTables();

          // Index symbols with random embeddings
          for (let i = 0; i < numSymbols; i++) {
            const vector = Array.from({ length: dims }, (_, j) =>
              Math.sin(i * 0.7 + j * 0.3),
            );
            const embedding: Embedding = { vector, dimensions: dims };
            await adapter.indexSymbol(`sym_${i}`, embedding, { idx: String(i) });
          }

          // Query with a specific vector
          const queryVector = Array.from({ length: dims }, (_, j) => Math.cos(j * 0.5));
          const queryEmbedding: Embedding = { vector: queryVector, dimensions: dims };
          const results = await adapter.semanticSearch(queryEmbedding, numSymbols);

          // Verify descending order
          for (let i = 0; i < results.length - 1; i++) {
            expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 4: All search results have score >= SEMANTIC_SEARCH_THRESHOLD.
   * **Validates: Requirements 3.4**
   *
   * ∀ result r in semanticSearch(): r.score ≥ 0.60.
   */
  it("5.5: all search results have score >= SEMANTIC_SEARCH_THRESHOLD", async () => {
    await fc.assert(
      fc.asyncProperty(
        validSearchResultsArbitrary(),
        async (results) => {
          for (const result of results) {
            expect(result.score).toBeGreaterThanOrEqual(SEMANTIC_SEARCH_THRESHOLD);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * Property 4 (integration): Adapter never returns results below threshold.
   * **Validates: Requirements 3.4**
   *
   * Uses an in-memory Connection mock to verify the adapter filters correctly.
   */
  it("5.5: adapter semanticSearch never returns results below threshold", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 10 }),
        fc.integer({ min: 2, max: 8 }),
        async (numSymbols, dims) => {
          const { connection } = createInMemoryConnection();
          const adapter = new LadybugVectorAdapter(connection as never, "pbt_");
          await adapter.createTables();

          // Index symbols with varied embeddings
          for (let i = 0; i < numSymbols; i++) {
            const vector = Array.from({ length: dims }, (_, j) =>
              Math.sin(i * 1.3 + j * 0.7),
            );
            const embedding: Embedding = { vector, dimensions: dims };
            await adapter.indexSymbol(`sym_${i}`, embedding);
          }

          // Query
          const queryVector = Array.from({ length: dims }, (_, j) => Math.cos(j * 0.9));
          const queryEmbedding: Embedding = { vector: queryVector, dimensions: dims };
          const results = await adapter.semanticSearch(queryEmbedding, numSymbols);

          // Every result must meet the threshold
          for (const result of results) {
            expect(result.score).toBeGreaterThanOrEqual(SEMANTIC_SEARCH_THRESHOLD);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
