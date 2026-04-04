/**
 * Property tests for vector store interface.
 *
 * Property 15: Search Result Ordering
 *   semanticSearch must return results ordered by descending similarity score.
 *   Validates: Requirement 17.4
 *
 * Note: These tests verify the logic without a live PostgreSQL instance
 * by mocking the Pool. Integration tests with a real DB live in
 * tests/integration/.
 */
import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { withRetry } from "./connection.js";
import { embeddingArbitrary } from "../types/arbitraries.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a mock Pool that returns pre-defined rows. */
function mockPool(rows: unknown[]) {
  return {
    query: vi.fn(async () => ({ rows })),
  };
}

// ─── Property 15: Search result ordering ─────────────────────────────────────

describe("semanticSearch (Property 15)", () => {
  it("returns results ordered by descending score", async () => {
    const { semanticSearch } = await import("./search.js");
    const mockRows = [
      { symbol_id: "a", score: "0.95", metadata: {} },
      { symbol_id: "b", score: "0.85", metadata: {} },
      { symbol_id: "c", score: "0.75", metadata: {} },
    ];
    const pool = mockPool(mockRows);
    const embedding = fc.sample(embeddingArbitrary(), 1)[0];

    const results = await semanticSearch(pool as never, embedding, 10);

    expect(results).toHaveLength(3);
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    expect(results[1].score).toBeGreaterThanOrEqual(results[2].score);
  });

  it("Property 15: results are always in descending score order", async () => {
    const { semanticSearch } = await import("./search.js");
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ symbol_id: fc.string(), score: fc.double({ min: 0, max: 1 }), metadata: fc.constant({}) }), { minLength: 2, maxLength: 20 }),
        embeddingArbitrary(),
        async (rows, embedding) => {
          // Mock returns rows sorted by descending score (simulating ORDER BY distance ASC)
          const sorted = [...rows].sort((a, b) => b.score - a.score);
          const pool = mockPool(sorted.map(r => ({ ...r, score: r.score.toString() })));
          const results = await semanticSearch(pool as never, embedding, 100);

          // Verify descending order
          for (let i = 0; i < results.length - 1; i++) {
            if (results[i].score < results[i + 1].score) return false;
          }
          return true;
        },
      ),
    );
  });

  it("handles empty results", async () => {
    const { semanticSearch } = await import("./search.js");
    const pool = mockPool([]);
    const embedding = fc.sample(embeddingArbitrary(), 1)[0];

    const results = await semanticSearch(pool as never, embedding, 10);
    expect(results).toHaveLength(0);
  });
});

// ─── withRetry ────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const result = await withRetry(async () => 42);
    expect(result).toBe(42);
  });

  it("retries on failure and succeeds on second attempt", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 2) throw new Error("transient");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("throws after maxAttempts failures", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error("always fails");
      }, 3),
    ).rejects.toThrow("always fails");
    expect(calls).toBe(3);
  });
});
