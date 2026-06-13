/**
 * Property tests for query intent classification.
 *
 * Property 13: Intent Classification Confidence
 *   For any non-empty query string, classifyIntent must return confidence >= 0.7.
 *   Validates: Requirements 9.2, 21.6, 24.3
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { classifyIntent } from "./intent.js";

// ─── Property 13: Intent Classification Confidence ───────────────────────────

describe("classifyIntent", () => {
  it("Property 13: confidence is always >= 0.7 for any non-empty text", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (text) => {
        const result = classifyIntent(text);
        expect(result.confidence).toBeGreaterThanOrEqual(0.7);
        expect(result.confidence).toBeLessThanOrEqual(1.0);
      }),
    );
  });

  it("returns a valid QueryIntent type for any input", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (text) => {
        const { intent } = classifyIntent(text);
        const validTypes = [
          "impactAnalysis", "smartSearch", "contextRetrieval",
          "dataFlowTrace", "preCommitCheck",
        ];
        expect(validTypes).toContain(intent.type);
      }),
    );
  });

  it("classifies impact-related queries correctly", () => {
    const { intent, confidence } = classifyIntent("what breaks if I change getUserById");
    expect(intent.type).toBe("impactAnalysis");
    expect(confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("classifies data flow queries correctly", () => {
    const { intent, confidence } = classifyIntent("trace data flow from /api/users endpoint");
    expect(intent.type).toBe("dataFlowTrace");
    expect(confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("classifies context retrieval queries correctly", () => {
    const { intent, confidence } = classifyIntent("who calls the authenticate function");
    expect(intent.type).toBe("contextRetrieval");
    expect(confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("falls back to smartSearch for unrecognized queries", () => {
    const { intent, confidence } = classifyIntent("find payment processing logic");
    expect(intent.type).toBe("smartSearch");
    expect(confidence).toBeGreaterThanOrEqual(0.7);
  });
});
