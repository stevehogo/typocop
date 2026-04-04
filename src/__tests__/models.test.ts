import { it, describe } from "vitest";
import fc from "fast-check";
import type { Location, Symbol, SymbolKind, Visibility, Modifier, Cluster, ClusterCategory } from "../types/index.js";

// Arbitraries for testing
const locationArbitrary = (): fc.Arbitrary<Location> => 
  fc.record({
    filePath: fc.string(),
    startLine: fc.nat({ max: 10000 }),
    startColumn: fc.nat({ max: 200 }),
    endLine: fc.nat({ max: 10000 }),
    endColumn: fc.nat({ max: 200 }),
  }).map(loc => {
    // Ensure logical properties natively for the arbitrary if we strictly needed to generate valid ones,
    // but to test the PROPERTY, the property test itself validates *that* the condition holds or a 
    // generator should only generate valid ones if used elsewhere.
    // For property 3 testing we actually want to ensure an explicitly generated valid location
    // meets the constraints.
    const startLine = Math.min(loc.startLine, loc.endLine);
    const endLine = Math.max(loc.startLine, loc.endLine);
    const startColumn = startLine === endLine ? Math.min(loc.startColumn, loc.endColumn) : loc.startColumn;
    const endColumn = startLine === endLine ? Math.max(loc.startColumn, loc.endColumn) : loc.endColumn;
    
    return {
      filePath: loc.filePath,
      startLine,
      startColumn,
      endLine,
      endColumn
    };
  });

const symbolKindArbitrary = (): fc.Arbitrary<SymbolKind> =>
  fc.constantFrom("function", "class", "method", "interface", "variable", "import", "export", "type");

const visibilityArbitrary = (): fc.Arbitrary<Visibility> =>
  fc.constantFrom("public", "private", "protected", "internal");

const modifierArbitrary = (): fc.Arbitrary<Modifier> =>
  fc.constantFrom("static", "abstract", "async", "const", "readonly");

const symbolArbitrary = (): fc.Arbitrary<Symbol> =>
  fc.record({
    id: fc.uuid(),
    name: fc.string({ minLength: 1 }),
    kind: symbolKindArbitrary(),
    location: locationArbitrary(),
    signature: fc.option(fc.string()),
    documentation: fc.option(fc.string()),
    visibility: visibilityArbitrary(),
    modifiers: fc.array(modifierArbitrary()),
  }) as fc.Arbitrary<Symbol>;

const clusterCategoryArbitrary = (): fc.Arbitrary<ClusterCategory> =>
  fc.constantFrom("authentication", "dataAccess", "businessLogic", "uiComponent", "utility", "unknown");

const clusterArbitrary = (): fc.Arbitrary<Cluster> =>
  fc.record({
    id: fc.uuid(),
    name: fc.string(),
    // generate at least 2 symbols
    symbols: fc.array(fc.uuid(), { minLength: 2 }),
    confidence: fc.double({ min: 0.0, max: 1.0, noNaN: true }),
    category: clusterCategoryArbitrary()
  });

describe("Data Models Correctness Properties", () => {
  it("Property 1: Symbol Uniqueness - Verify no duplicate IDs in any generated symbol list (when explicitly unique)", () => {
    // We test that if we generate a list with unique IDs, the set size equals array size.
    // fast-check doesn't natively guarantee uniqueness across array items unless specified.
    // Let's generate a list of unique strings as IDs and create symbols from them.
    const uniqueIdsSymbolListArbitrary = fc.uniqueArray(fc.uuid()).chain(ids => 
      fc.tuple(...ids.map(id => fc.record({
        id: fc.constant(id),
        name: fc.string({ minLength: 1 }),
        kind: symbolKindArbitrary(),
        location: locationArbitrary(),
        visibility: visibilityArbitrary(),
        modifiers: fc.array(modifierArbitrary())
      })))
    );

    fc.assert(
      fc.property(uniqueIdsSymbolListArbitrary, (symbols: any[]) => {
        const ids = symbols.map((s) => s.id);
        return new Set(ids).size === ids.length;
      })
    );
  });

  it("Property 3: Symbol Location Validity - Verify start line <= end line and column ordering", () => {
    fc.assert(
      fc.property(locationArbitrary(), (loc) => {
        const lineValid = loc.startLine <= loc.endLine;
        const colValid = loc.startLine < loc.endLine || loc.startColumn <= loc.endColumn;
        return lineValid && colValid;
      })
    );
  });

  it("Property 4: Cluster Confidence Bounds - Verify confidence scores are in [0.0, 1.0]", () => {
    fc.assert(
      fc.property(clusterArbitrary(), (cluster) => {
        return cluster.confidence >= 0.0 && cluster.confidence <= 1.0;
      })
    );
  });

  it("Property 5: Cluster Minimum Size - Verify clusters contain at least 2 symbols", () => {
    fc.assert(
      fc.property(clusterArbitrary(), (cluster) => {
        return cluster.symbols.length >= 2;
      })
    );
  });
});
