/**
 * Preservation Property-Based Tests: PostgreSQL Vector Store
 *
 * These tests verify that single-instance semantic search behavior on UNFIXED code
 * remains identical before and after the fix. They establish a baseline of correctness
 * that must be preserved when prefixes are added.
 *
 * **EXPECTED OUTCOME**: Tests PASS on unfixed code (confirms baseline to preserve)
 *
 * Property 2: PostgreSQL semantic search returns identical results before and after fix
 * Property 3: Single-instance behavior is preserved (Requirements 3.2, 3.4, 3.5, 3.6)
 *
 * Validates: Requirements 3.2, 3.4, 3.5, 3.6
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
import type { Pool } from "pg";
import type { Embedding, SearchResult } from "../types/index.js";

// ─── Mock Pool Factory ─────────────────────────────────────────────────────────

interface MockPool {
  pool: Pool;
  queries: Array<{ sql: string; params: unknown[] }>;
  embeddings: Map<string, { embedding: number[]; metadata: Record<string, string> }>;
  setQueryResults: (results: unknown[]) => void;
}

function makeMockPool(): MockPool {
  const embeddings = new Map<string, { embedding: number[]; metadata: Record<string, string> }>();
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let queryResults: unknown[] = [];

  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });

      // Simulate INSERT INTO prefixed embeddings table (e.g., tpc_embeddings)
      if (sql.includes("INSERT INTO") && sql.includes("embeddings")) {
        const symbolId = params?.[0] as string;
        const embeddingVector = JSON.parse(params?.[1] as string) as number[];
        const metadata = JSON.parse(params?.[2] as string) as Record<string, string>;

        embeddings.set(symbolId, { embedding: embeddingVector, metadata });
        return { rows: [] };
      }

      // Simulate SELECT from prefixed embeddings table (semantic search)
      if (sql.includes("SELECT") && sql.includes("FROM") && sql.includes("embeddings")) {
        // Extract limit from params (it's the second parameter in semanticSearch)
        const limit = (params?.[1] as number) || 10;
        // Parse metadata strings in queryResults back to objects and apply limit
        return {
          rows: queryResults
            .slice(0, limit)
            .map((row: any) => ({
              ...row,
              metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
            })),
        };
      }

      return { rows: [] };
    }),
  } as unknown as Pool;

  return {
    pool,
    queries,
    embeddings,
    setQueryResults: (results: unknown[]) => {
      queryResults = results;
    },
  };
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const symbolIdArbitrary = (): fc.Arbitrary<string> =>
  fc.stringMatching(/^[a-z0-9_-]{1,20}$/);

const embeddingVectorArbitrary = (): fc.Arbitrary<number[]> =>
  fc.array(fc.float({ min: -1, max: 1, noNaN: true }), {
    minLength: 1536,
    maxLength: 1536,
  });

const embeddingArbitrary = (): fc.Arbitrary<Embedding> =>
  fc.record({
    vector: embeddingVectorArbitrary(),
    dimensions: fc.constant(1536),
  });

const metadataArbitrary = (): fc.Arbitrary<Record<string, string>> =>
  fc.record({
    source: fc.stringMatching(/^[a-z0-9_]{1,10}$/),
    kind: fc.oneof(fc.constant("function"), fc.constant("class"), fc.constant("method")),
  });

// ─── Preservation Tests ────────────────────────────────────────────────────────

describe("PostgreSQL Preservation Properties: Single-Instance Semantic Search", () => {
  let mockPool: MockPool;

  beforeEach(() => {
    mockPool = makeMockPool();
  });

  it("Property 1: indexSymbol stores embeddings that can be retrieved", async () => {
    // Property: For any symbol ID and embedding, storing it and then retrieving it
    // produces the same embedding (within floating-point precision).

    const { indexSymbol } = await import("./index-store.js");

    await fc.assert(
      fc.asyncProperty(
        symbolIdArbitrary(),
        embeddingArbitrary(),
        metadataArbitrary(),
        async (symbolId, embedding, metadata) => {
          const testPool = makeMockPool();

          // Act: index symbol with prefix
          await indexSymbol(testPool.pool, symbolId, embedding, metadata, "tpc_");

          // Assert: embedding is stored
          const stored = testPool.embeddings.get(symbolId);
          expect(stored).toBeDefined();
          expect(stored?.embedding).toHaveLength(1536);

          // Verify embedding values are close (within floating-point precision)
          for (let i = 0; i < embedding.vector.length; i++) {
            expect(stored?.embedding[i]).toBeCloseTo(embedding.vector[i], 5);
          }

          // Verify metadata is stored
          expect(stored?.metadata).toEqual(metadata);
        },
      ),
      { numRuns: 10 },
    );
  });

  it("Property 2: Multiple indexes to same symbol ID result in latest embedding", async () => {
    // Property: When the same symbol ID is indexed twice with different embeddings,
    // the final stored embedding is the latest one (UPSERT semantics).

    const { indexSymbol } = await import("./index-store.js");

    await fc.assert(
      fc.asyncProperty(
        symbolIdArbitrary(),
        fc.array(embeddingArbitrary(), { minLength: 2, maxLength: 5 }),
        metadataArbitrary(),
        async (symbolId, embeddings, metadata) => {
          const testPool = makeMockPool();

          // Act: index same symbol multiple times with different embeddings
          for (const embedding of embeddings) {
            await indexSymbol(testPool.pool, symbolId, embedding, metadata, "tpc_");
          }

          // Assert: final stored embedding is the last one
          const stored = testPool.embeddings.get(symbolId);
          expect(stored).toBeDefined();

          const lastEmbedding = embeddings[embeddings.length - 1];
          for (let i = 0; i < lastEmbedding.vector.length; i++) {
            expect(stored?.embedding[i]).toBeCloseTo(lastEmbedding.vector[i], 5);
          }
        },
      ),
      { numRuns: 10 },
    );
  });

  it("Property 3: Semantic search returns results ordered by similarity", async () => {
    // Property: For any query embedding, semantic search returns results
    // ordered by descending similarity score (1 - distance).

    const { indexSymbol } = await import("./index-store.js");
    const { semanticSearch } = await import("./search.js");

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            symbolId: symbolIdArbitrary(),
            embedding: embeddingArbitrary(),
          }),
          { minLength: 2, maxLength: 5 },
        ),
        embeddingArbitrary(),
        async (symbols, queryEmbedding) => {
          const testPool = makeMockPool();

          // Act: index all symbols
          for (const { symbolId, embedding } of symbols) {
            await indexSymbol(testPool.pool, symbolId, embedding, {}, "tpc_");
          }

          // Simulate search results: return all symbols with computed similarity scores
          const results = symbols.map(({ symbolId, embedding }) => {
            // Compute cosine similarity
            let dotProduct = 0;
            let normA = 0;
            let normB = 0;

            for (let i = 0; i < embedding.vector.length; i++) {
              dotProduct += queryEmbedding.vector[i] * embedding.vector[i];
              normA += queryEmbedding.vector[i] ** 2;
              normB += embedding.vector[i] ** 2;
            }

            const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
            const score = 1 - Math.acos(Math.max(-1, Math.min(1, similarity))) / Math.PI; // Normalize to [0, 1]

            return {
              symbol_id: symbolId,
              score: score.toString(),
              metadata: JSON.stringify({}),
            };
          });

          // Sort by score descending
          results.sort((a, b) => parseFloat(b.score) - parseFloat(a.score));
          testPool.setQueryResults(results);

          // Act: search
          const searchResults = await semanticSearch(testPool.pool, queryEmbedding, 10, "tpc_");

          // Assert: results are ordered by descending score
          for (let i = 1; i < searchResults.length; i++) {
            expect(searchResults[i - 1].score).toBeGreaterThanOrEqual(searchResults[i].score);
          }
        },
      ),
      { numRuns: 10 },
    );
  });

  it("Property 4: Search limit is respected", async () => {
    // Property: For any limit N, semantic search returns at most N results.

    const { semanticSearch } = await import("./search.js");

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 100 }),
        fc.array(
          fc.record({
            symbol_id: symbolIdArbitrary(),
            score: fc.float({ min: 0, max: 1 }),
            metadata: fc.constant("{}"),
          }),
          { minLength: 1, maxLength: 200 },
        ),
        embeddingArbitrary(),
        async (limit, mockResults, queryEmbedding) => {
          const testPool = makeMockPool();
          testPool.setQueryResults(mockResults);

          // Act: search with limit
          const results = await semanticSearch(testPool.pool, queryEmbedding, limit, "tpc_");

          // Assert: result count <= limit
          expect(results.length).toBeLessThanOrEqual(limit);
        },
      ),
      { numRuns: 10 },
    );
  });

  it("Property 5: Search results have valid structure", async () => {
    // Property: For any search result, it has symbolId, score, and metadata fields.

    const { semanticSearch } = await import("./search.js");

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            symbol_id: symbolIdArbitrary(),
            score: fc.float({ min: 0, max: 1 }).map((n) => n.toString()),
            metadata: fc.constant("{}"),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        embeddingArbitrary(),
        async (mockResults, queryEmbedding) => {
          const testPool = makeMockPool();
          testPool.setQueryResults(mockResults);

          // Act: search
          const results = await semanticSearch(testPool.pool, queryEmbedding, 10, "tpc_");

          // Assert: each result has required fields
          for (const result of results) {
            expect(result).toHaveProperty("symbolId");
            expect(result).toHaveProperty("score");
            expect(result).toHaveProperty("metadata");

            expect(typeof result.symbolId).toBe("string");
            expect(typeof result.score).toBe("number");
            expect(typeof result.metadata).toBe("object");
          }
        },
      ),
      { numRuns: 10 },
    );
  });

  it("Property 6: Empty search results are handled correctly", async () => {
    // Property: When no embeddings match the query, semantic search returns empty array.

    const { semanticSearch } = await import("./search.js");

    const testPool = makeMockPool();
    testPool.setQueryResults([]);

    const queryEmbedding: Embedding = {
      vector: new Array(1536).fill(0.5),
      dimensions: 1536,
    };

    // Act: search with no results
    const results = await semanticSearch(testPool.pool, queryEmbedding, 10, "tpc_");

    // Assert: empty array returned
    expect(results).toEqual([]);
  });

  it("Property 7: Metadata is preserved through index and search", async () => {
    // Property: For any metadata object stored with an embedding,
    // searching and retrieving it preserves the metadata exactly.

    const { indexSymbol } = await import("./index-store.js");
    const { semanticSearch } = await import("./search.js");

    await fc.assert(
      fc.asyncProperty(
        symbolIdArbitrary(),
        embeddingArbitrary(),
        metadataArbitrary(),
        async (symbolId, embedding, metadata) => {
          const testPool = makeMockPool();

          // Act: index symbol with metadata
          await indexSymbol(testPool.pool, symbolId, embedding, metadata, "tpc_");

          // Simulate search returning the indexed symbol
          testPool.setQueryResults([
            {
              symbol_id: symbolId,
              score: "0.95",
              metadata: JSON.stringify(metadata),
            },
          ]);

          // Act: search
          const results = await semanticSearch(testPool.pool, embedding, 10, "tpc_");

          // Assert: metadata is preserved
          expect(results).toHaveLength(1);
          expect(results[0].metadata).toEqual(metadata);
        },
      ),
      { numRuns: 10 },
    );
  });

  it("Property 8: Connection pool queries use correct table name", async () => {
    // Property: All queries to the vector store reference the 'embeddings' table
    // (before fix) or prefixed table (after fix).

    const { indexSymbol } = await import("./index-store.js");
    const { semanticSearch } = await import("./search.js");

    const testPool = makeMockPool();
    const symbolId = "test-symbol";
    const embedding: Embedding = {
      vector: new Array(1536).fill(0.5),
      dimensions: 1536,
    };

    // Act: index and search
    await indexSymbol(testPool.pool, symbolId, embedding, {}, "tpc_");
    testPool.setQueryResults([]);
    await semanticSearch(testPool.pool, embedding, 10, "tpc_");

    // Assert: all queries reference prefixed 'embeddings' table
    const allQueries = testPool.queries.map((q) => q.sql);
    const insertQueries = allQueries.filter((q) => q.includes("INSERT"));
    const selectQueries = allQueries.filter((q) => q.includes("SELECT"));

    // After fix: all reference prefixed 'tpc_embeddings'
    for (const query of insertQueries) {
      expect(query).toContain("tpc_embeddings");
    }

    for (const query of selectQueries) {
      expect(query).toContain("tpc_embeddings");
    }
  });
});
