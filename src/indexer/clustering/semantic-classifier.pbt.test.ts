/**
 * Property-based test: semantic classification never returns a category
 * not in ClusterCategory.
 *
 * **Validates: Requirements 10.2**
 *
 * Uses fast-check to verify that for any input text, the classifier
 * never returns a value outside the ClusterCategory union type.
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as fc from "fast-check";
import type { ClusterCategory, Embedding } from "../../types/index.js";
import type { EmbeddingAdapter } from "../../db/types.js";
import {
  SemanticClusterClassifier,
  ALL_CATEGORIES,
  CATEGORY_REFERENCE_TEXTS,
} from "./semantic-classifier.js";

// ─── Valid category set ───────────────────────────────────────────────────────

const VALID_CATEGORIES = new Set<ClusterCategory>(ALL_CATEGORIES);

// ─── Mock embedder that returns deterministic vectors ─────────────────────────

function createDeterministicEmbedder(): EmbeddingAdapter {
  let callCount = 0;
  return {
    isEnabled: () => true,
    embedText: async (text: string): Promise<Embedding | null> => {
      // Generate a deterministic vector from the text hash
      const dim = 8;
      const vector = new Array(dim).fill(0);
      let hash = 0;
      for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
      }
      for (let i = 0; i < dim; i++) {
        vector[i] = Math.sin(hash + i * 1.618);
      }
      callCount++;
      return { vector, dimensions: dim };
    },
    getDimensions: () => 8,
  };
}

// ─── Property test ────────────────────────────────────────────────────────────

describe("Property: semantic classification returns valid ClusterCategory", () => {
  let classifier: SemanticClusterClassifier;

  beforeAll(async () => {
    classifier = new SemanticClusterClassifier();
    await classifier.initialize(createDeterministicEmbedder());
  });

  /**
   * **Validates: Requirements 10.2**
   *
   * For any arbitrary string input, classify() must return a value
   * that is a member of the ClusterCategory union type.
   */
  it("classify() always returns a valid ClusterCategory for any input text", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 200 }),
        async (text) => {
          const result = await classifier.classify(text);
          expect(VALID_CATEGORIES.has(result)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 10.2**
   *
   * For any arbitrary string composed of symbol-like identifiers,
   * classify() must return a valid ClusterCategory.
   */
  it("classify() returns valid category for symbol-like inputs", async () => {
    const symbolTextArb = fc
      .array(
        fc.tuple(
          fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,30}$/),
          fc.constantFrom("function", "class", "method", "interface", "variable"),
        ),
        { minLength: 1, maxLength: 10 },
      )
      .map((pairs) => pairs.map(([name, kind]) => `${name} (${kind})`).join(", "));

    await fc.assert(
      fc.asyncProperty(symbolTextArb, async (text) => {
        const result = await classifier.classify(text);
        expect(VALID_CATEGORIES.has(result)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
