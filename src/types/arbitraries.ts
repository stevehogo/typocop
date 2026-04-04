/**
 * Reusable fast-check arbitraries for core data model types.
 * Import these in property tests across the codebase.
 */
import * as fc from "fast-check";
import type {
  Location,
  Symbol,
  SymbolKind,
  Visibility,
  Modifier,
  Cluster,
  ClusterCategory,
} from "./index.js";

// ─── Primitives ───────────────────────────────────────────────────────────────

const symbolKindArbitrary = (): fc.Arbitrary<SymbolKind> =>
  fc.constantFrom(
    "function", "class", "method", "interface",
    "variable", "import", "export", "type"
  );

const visibilityArbitrary = (): fc.Arbitrary<Visibility> =>
  fc.constantFrom("public", "private", "protected", "internal");

const modifierArbitrary = (): fc.Arbitrary<Modifier> =>
  fc.constantFrom("static", "abstract", "async", "const", "readonly");

const clusterCategoryArbitrary = (): fc.Arbitrary<ClusterCategory> =>
  fc.constantFrom(
    "authentication", "dataAccess", "businessLogic",
    "uiComponent", "utility", "unknown"
  );

// ─── Location ─────────────────────────────────────────────────────────────────

export const locationArbitrary = (): fc.Arbitrary<Location> =>
  fc
    .record({
      filePath: fc.string({ minLength: 1 }),
      startLine: fc.nat({ max: 10_000 }),
      startColumn: fc.nat({ max: 500 }),
      lineDelta: fc.nat({ max: 100 }),
      endColumn: fc.nat({ max: 500 }),
    })
    .map(({ filePath, startLine, startColumn, lineDelta, endColumn }) => ({
      filePath,
      startLine,
      startColumn,
      endLine: startLine + lineDelta,
      // When on the same line, endColumn must be >= startColumn
      endColumn: lineDelta === 0 ? startColumn + endColumn : endColumn,
    }));

// ─── Symbol ───────────────────────────────────────────────────────────────────

export const symbolArbitrary = (): fc.Arbitrary<Symbol> =>
  fc.record({
    id: fc.string({ minLength: 1 }),
    name: fc.string({ minLength: 1 }),
    kind: symbolKindArbitrary(),
    location: locationArbitrary(),
    signature: fc.option(fc.string(), { nil: undefined }),
    documentation: fc.option(fc.string(), { nil: undefined }),
    visibility: visibilityArbitrary(),
    modifiers: fc.array(modifierArbitrary(), { maxLength: 5 }),
  });

// ─── Cluster ──────────────────────────────────────────────────────────────────

/** Generates a valid cluster: confidence in [0,1], at least 2 symbol IDs. */
export const clusterArbitrary = (): fc.Arbitrary<Cluster> =>
  fc.record({
    id: fc.string({ minLength: 1 }),
    name: fc.string({ minLength: 1 }),
    symbols: fc.array(fc.string({ minLength: 1 }), { minLength: 2 }),
    confidence: fc.double({ min: 0, max: 1, noNaN: true }),
    category: clusterCategoryArbitrary(),
  });
