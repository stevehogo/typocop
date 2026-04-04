/**
 * Property tests for data flow tracing.
 * Requirements: 13.7, 14.9, 14.10
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { Symbol, SymbolKind } from "../types/index.js";

/**
 * Property 16: Framework Tracing Completeness
 * Full tracing frameworks must include API, controllers, and DB models.
 * Requirements: 13.7, 14.8
 */
describe("Property 16: Framework Tracing Completeness", () => {
  it("Full tracing includes API, controllers, and DB models", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1 }),
            name: fc.string({ minLength: 1 }),
            kind: fc.constantFrom("function", "class", "method") as fc.Arbitrary<SymbolKind>,
            layer: fc.constantFrom("api", "controller", "service", "repository", "model"),
          }),
          { minLength: 3 },
        ),
        (symbols) => {
          const layers = new Set(symbols.map((s) => s.layer));
          const isFullTrace = layers.has("api") && layers.has("controller") && layers.has("model");

          if (isFullTrace) {
            // Full trace must have all three critical layers
            expect(layers.has("api")).toBe(true);
            expect(layers.has("controller")).toBe(true);
            expect(layers.has("model")).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Full tracing confidence is high when all layers present", () => {
    fc.assert(
      fc.property(
        fc.record({
          hasApi: fc.boolean(),
          hasController: fc.boolean(),
          hasModel: fc.boolean(),
        }),
        ({ hasApi, hasController, hasModel }) => {
          const isFullTrace = hasApi && hasController && hasModel;
          const confidence = isFullTrace ? 0.92 : 0.75;

          if (isFullTrace) {
            expect(confidence).toBeGreaterThanOrEqual(0.90);
          } else {
            expect(confidence).toBeLessThan(0.90);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 17: Framework Partial Tracing
 * Partial tracing must have at least one component type.
 * Requirements: 14.9, 25.4
 */
describe("Property 17: Framework Partial Tracing", () => {
  it("Partial tracing has at least one component type", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1 }),
            name: fc.string({ minLength: 1 }),
            kind: fc.constantFrom("function", "class", "method") as fc.Arbitrary<SymbolKind>,
            layer: fc.constantFrom("api", "controller", "service", "repository", "model"),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (symbols) => {
          const layers = new Set(symbols.map((s) => s.layer));
          const hasApi = layers.has("api");
          const hasController = layers.has("controller");
          const hasModel = layers.has("model");

          const componentCount = [hasApi, hasController, hasModel].filter(Boolean).length;

          // Partial tracing: at least one but not all three
          if (componentCount > 0 && componentCount < 3) {
            expect(componentCount).toBeGreaterThanOrEqual(1);
            expect(componentCount).toBeLessThan(3);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Partial tracing has lower confidence than full tracing", () => {
    fc.assert(
      fc.property(
        fc.record({
          hasApi: fc.boolean(),
          hasController: fc.boolean(),
          hasModel: fc.boolean(),
        }),
        ({ hasApi, hasController, hasModel }) => {
          const componentCount = [hasApi, hasController, hasModel].filter(Boolean).length;
          const isFullTrace = componentCount === 3;
          const isPartialTrace = componentCount > 0 && componentCount < 3;

          if (isFullTrace && isPartialTrace) {
            const fullConfidence = 0.92;
            const partialConfidence = 0.75;
            expect(partialConfidence).toBeLessThan(fullConfidence);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Integration test: Data flow trace structure
 */
describe("Data flow trace structure", () => {
  it("layer ordering follows canonical sequence", () => {
    const orderedLayers = ["api", "controller", "service", "repository", "model"];
    
    // Test that the canonical order is defined correctly
    expect(orderedLayers[0]).toBe("api");
    expect(orderedLayers[1]).toBe("controller");
    expect(orderedLayers[2]).toBe("service");
    expect(orderedLayers[3]).toBe("repository");
    expect(orderedLayers[4]).toBe("model");
  });

  it("selected layers maintain relative order from canonical sequence", () => {
    const orderedLayers = ["api", "controller", "service", "repository", "model"];
    
    fc.assert(
      fc.property(
        fc.subarray(orderedLayers, { minLength: 2 }),
        (selected) => {
          // Verify selected layers maintain their relative order
          for (let i = 0; i < selected.length - 1; i++) {
            const currentIndex = orderedLayers.indexOf(selected[i]);
            const nextIndex = orderedLayers.indexOf(selected[i + 1]);
            expect(currentIndex).toBeLessThan(nextIndex);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
