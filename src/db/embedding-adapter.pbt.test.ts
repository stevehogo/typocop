/**
 * Property-based tests for embedding adapter dimension consistency.
 *
 * **Validates: Requirements 4.2, 9.2**
 *
 * Property 5 from design-correctness.md:
 * ∀ embedding E: E.vector.length === E.dimensions.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as fc from "fast-check";
import { OllamaEmbeddingAdapter } from "./ollama-embedding-adapter.js";
import type { OllamaConfig } from "../platform/config/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(dimensions: number): OllamaConfig {
  return {
    enabled: true,
    url: "http://localhost:11434",
    model: "qwen3-embedding:4b",
    dimensions,
  };
}

/** Safe symbol-metadata text that passes the privacy check. */
const safeTextArbitrary = (): fc.Arbitrary<string> =>
  fc
    .array(
      fc.oneof(
        fc.constantFrom(
          "myFunction", "MyClass", "handleRequest", "processData",
          "getUserById", "validateInput", "parseConfig", "buildQuery",
        ),
        fc.constantFrom(
          "public", "private", "async", "static", "readonly",
          "method", "class", "interface", "variable",
        ),
      ),
      { minLength: 1, maxLength: 5 },
    )
    .map((words) => words.join(" "));

// ─── Property Tests ──────────────────────────────────────────────────────────

describe("EmbeddingAdapter — property tests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Property 5: Embedding dimension consistency.
   * **Validates: Requirements 4.2, 9.2**
   *
   * ∀ embedding E produced by OllamaEmbeddingAdapter:
   *   E.vector.length === E.dimensions
   */
  it("6.5: embedding vector.length === dimensions for all successful embeddings", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 512 }),
        safeTextArbitrary(),
        async (dims, text) => {
          const config = makeConfig(dims);
          const adapter = new OllamaEmbeddingAdapter(config);

          // Mock fetch to return a vector of exactly `dims` length
          const vector = Array.from({ length: dims }, (_, i) => i * 0.01);
          const mockResponse = new Response(
            JSON.stringify({ embedding: vector, model: config.model }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
          vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse);

          const result = await adapter.embedText(text);

          // When the adapter returns an embedding, the invariant must hold
          if (result !== null) {
            expect(result.vector.length).toBe(result.dimensions);
            expect(result.dimensions).toBe(dims);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 5 (negative): Dimension mismatch yields null.
   * **Validates: Requirements 4.2, 9.2**
   *
   * When Ollama returns a vector whose length ≠ configured dimensions,
   * the adapter must return null (never an inconsistent Embedding).
   */
  it("6.5: dimension mismatch always returns null, never an inconsistent Embedding", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 512 }),
        fc.integer({ min: 1, max: 511 }),
        safeTextArbitrary(),
        async (configDims, responseDims, text) => {
          // Ensure mismatch
          fc.pre(configDims !== responseDims);

          const config = makeConfig(configDims);
          const adapter = new OllamaEmbeddingAdapter(config);

          const vector = Array.from({ length: responseDims }, (_, i) => i * 0.01);
          const mockResponse = new Response(
            JSON.stringify({ embedding: vector, model: config.model }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
          vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse);

          const result = await adapter.embedText(text);

          expect(result).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});
