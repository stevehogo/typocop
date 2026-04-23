/**
 * Property-based and example-based tests for Levenshtein edit distance.
 * Validates: Requirements 2.5, 5.4
 *
 * Properties tested:
 * - Property 5: Symmetry — levenshteinDistance(a, b) === levenshteinDistance(b, a)
 * - Property 6: Identity — levenshteinDistance(x, x) === 0
 * - Property 7: Non-negativity — levenshteinDistance(a, b) >= 0
 * - Triangle inequality — levenshteinDistance(a, c) <= levenshteinDistance(a, b) + levenshteinDistance(b, c)
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { levenshteinDistance } from "./levenshtein.js";

// ─── Property-Based Tests ─────────────────────────────────────────────────────

describe("levenshteinDistance — property-based tests", () => {
  /**
   * Property 5: Levenshtein symmetry.
   * **Validates: Requirements 2.5**
   */
  it("is symmetric: distance(a, b) === distance(b, a)", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        return levenshteinDistance(a, b) === levenshteinDistance(b, a);
      }),
    );
  });

  /**
   * Property 6: Levenshtein identity.
   * **Validates: Requirements 2.5**
   */
  it("identity: distance(x, x) === 0 for all strings", () => {
    fc.assert(
      fc.property(fc.string(), (x) => {
        return levenshteinDistance(x, x) === 0;
      }),
    );
  });

  /**
   * Property 7: Levenshtein non-negativity.
   * **Validates: Requirements 2.5**
   */
  it("non-negativity: distance(a, b) >= 0 for all strings", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        return levenshteinDistance(a, b) >= 0;
      }),
    );
  });

  /**
   * Triangle inequality: distance(a, c) <= distance(a, b) + distance(b, c).
   * **Validates: Requirements 2.5**
   */
  it("triangle inequality: distance(a, c) <= distance(a, b) + distance(b, c)", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (a, b, c) => {
        return (
          levenshteinDistance(a, c) <=
          levenshteinDistance(a, b) + levenshteinDistance(b, c)
        );
      }),
    );
  });
});

// ─── Example-Based Tests ──────────────────────────────────────────────────────

describe("levenshteinDistance — example-based tests", () => {
  it("returns 3 for 'kitten' and 'sitting'", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
  });

  it("returns 3 for empty string and 'abc'", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
  });

  it("returns 0 for identical strings 'abc' and 'abc'", () => {
    expect(levenshteinDistance("abc", "abc")).toBe(0);
  });

  it("returns 0 for two empty strings", () => {
    expect(levenshteinDistance("", "")).toBe(0);
  });

  it("returns length of non-empty string when other is empty", () => {
    expect(levenshteinDistance("hello", "")).toBe(5);
    expect(levenshteinDistance("", "world")).toBe(5);
  });

  it("returns 1 for single character substitution", () => {
    expect(levenshteinDistance("cat", "car")).toBe(1);
  });

  it("returns 1 for single character insertion", () => {
    expect(levenshteinDistance("cat", "cats")).toBe(1);
  });

  it("returns 1 for single character deletion", () => {
    expect(levenshteinDistance("cats", "cat")).toBe(1);
  });
});
