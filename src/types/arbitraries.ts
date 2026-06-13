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
  Embedding,
  Process,
  ProcessStep,
} from "../core/domain.js";

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

// ─── Embedding ────────────────────────────────────────────────────────────────

/** Generates a valid Embedding: vector with exactly 1536 elements, dimensions === 1536. */
export const embeddingArbitrary = (): fc.Arbitrary<Embedding> =>
  fc.record({
    vector: fc.array(fc.float({ noNaN: true }), { minLength: 1536, maxLength: 1536 }),
    dimensions: fc.constant(1536 as const),
  });

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

// ─── Process ──────────────────────────────────────────────────────────────────

/**
 * Generates a valid ProcessStep with 0-indexed sequential order.
 * The `order` field is set externally by processArbitrary to ensure no gaps.
 */
const processStepArbitrary = (order: number): fc.Arbitrary<ProcessStep> =>
  fc.record({
    order: fc.constant(order),
    symbolId: fc.string({ minLength: 1 }),
    description: fc.string({ minLength: 1 }),
  });

/**
 * Generates a valid Process:
 * - at least 2 steps
 * - steps[i].order === i (0-indexed, sequential, no gaps)
 */
export const processArbitrary = (): fc.Arbitrary<Process> =>
  fc
    .integer({ min: 2, max: 10 })
    .chain((stepCount) =>
      fc.record({
        id: fc.string({ minLength: 1 }),
        name: fc.string({ minLength: 1 }),
        entryPoint: fc.string({ minLength: 1 }),
        steps: fc.tuple(...Array.from({ length: stepCount }, (_, i) => processStepArbitrary(i))),
        dataFlow: fc.array(
          fc.record({
            from: fc.string({ minLength: 1 }),
            to: fc.string({ minLength: 1 }),
            dataType: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
          }),
        ),
      }),
    )
    .map((rec) => ({
      ...rec,
      steps: Array.from(rec.steps),
    }));

// ─── FileNode (for parsing tests) ─────────────────────────────────────────────

import type { FileNode } from "../application/indexing/structure/index.js";

const languageArbitrary = (): fc.Arbitrary<string> =>
  fc.constantFrom(
    "typescript", "javascript", "python", "php", "java",
    "go", "rust", "c", "cpp", "csharp", "ruby", "swift"
  );

/** Generates a valid FileNode with relative path and supported language. */
export const fileNodeArbitrary = (): fc.Arbitrary<FileNode> =>
  fc.record({
    path: fc.string({ minLength: 1, maxLength: 100 }).map(p => p.replace(/\\/g, "/")),
    size: fc.nat({ max: 1_000_000 }),
    language: languageArbitrary() as fc.Arbitrary<any>,
  });
