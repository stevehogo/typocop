/**
 * Property tests for AI Context Enrichment.
 *
 * Property 13: Intent Classification Confidence
 *   For any non-empty query string, classifyIntent must return confidence >= 0.7.
 *   Validates: Requirements 9.2, 21.6, 24.3
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { classifyIntent } from "./intent.js";
import { classifyQueryIntent } from "./index.js";
import { analyzeSideEffects, inferTypes } from "./side-effects.js";
import type { EnrichmentConfig } from "./config.js";
import { symbolArbitrary } from "../types/arbitraries.js";
import type { Symbol } from "../types/index.js";

const defaultConfig: EnrichmentConfig = {
  embeddingModel: "text-embedding-3-large",
  dimensions: 1536,
  enableIntentClassification: true,
  enableSideEffectAnalysis: true,
  enableTypeInference: true,
};

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

describe("classifyQueryIntent (with config)", () => {
  it("respects enableIntentClassification=false and still returns confidence >= 0.7", () => {
    const disabledConfig: EnrichmentConfig = { ...defaultConfig, enableIntentClassification: false };
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (text) => {
        const result = classifyQueryIntent(text, disabledConfig);
        expect(result.confidence).toBeGreaterThanOrEqual(0.7);
        expect(result.intent.type).toBe("smartSearch");
      }),
    );
  });
});

// ─── Side effect analysis ─────────────────────────────────────────────────────

describe("analyzeSideEffects", () => {
  it("returns an array for any symbol", () => {
    fc.assert(
      fc.property(symbolArbitrary(), (symbol) => {
        const effects = analyzeSideEffects(symbol);
        expect(Array.isArray(effects)).toBe(true);
      }),
    );
  });

  it("detects mutation for save/update/delete names", () => {
    const sym: Symbol = {
      id: "1", name: "saveUser", kind: "function",
      location: { filePath: "a.ts", startLine: 1, startColumn: 0, endLine: 5, endColumn: 0 },
      visibility: "public", modifiers: [],
    };
    expect(analyzeSideEffects(sym)).toContain("mutation");
  });

  it("detects async modifier", () => {
    const sym: Symbol = {
      id: "2", name: "fetchData", kind: "function",
      location: { filePath: "a.ts", startLine: 1, startColumn: 0, endLine: 5, endColumn: 0 },
      visibility: "public", modifiers: ["async"],
    };
    expect(analyzeSideEffects(sym)).toContain("async");
  });
});

// ─── Type inference ───────────────────────────────────────────────────────────

describe("inferTypes", () => {
  it("returns an object for any symbol", () => {
    fc.assert(
      fc.property(symbolArbitrary(), (symbol) => {
        const types = inferTypes(symbol);
        expect(typeof types).toBe("object");
      }),
    );
  });

  it("infers boolean for isXxx naming convention in JS files", () => {
    const sym: Symbol = {
      id: "3", name: "isActive", kind: "function",
      location: { filePath: "src/utils/check.js", startLine: 1, startColumn: 0, endLine: 5, endColumn: 0 },
      visibility: "public", modifiers: [],
    };
    const types = inferTypes(sym);
    expect(types["return"]).toBe("boolean");
  });
});
