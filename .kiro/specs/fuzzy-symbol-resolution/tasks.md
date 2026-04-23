# Tasks: Fuzzy Symbol Resolution

## Task 1: Extract shared graph helpers

- [x] 1.1 Create `src/query/graph-helpers.ts` with shared `CypherNodeRow` interface, `rowToNode`, and `graphNodeToSymbol` functions extracted from the duplicated code in `context-retrieval.ts`, `impact-analysis.ts`, and `data-flow-trace.ts`.
  _Requirements: 5.5_
- [x] 1.2 Update `context-retrieval.ts` to import `rowToNode` and `graphNodeToSymbol` from `graph-helpers.ts` and remove its local copies.
  _Requirements: 5.5_
- [x] 1.3 Update `impact-analysis.ts` to import `rowToNode` and `graphNodeToSymbol` from `graph-helpers.ts` and remove its local copies.
  _Requirements: 5.5_
- [x] 1.4 Update `data-flow-trace.ts` to import `rowToNode` and `graphNodeToSymbol` from `graph-helpers.ts` and remove its local copies.
  _Requirements: 5.5_

## Task 2: Implement Levenshtein distance

- [x] 2.1 Create `src/query/levenshtein.ts` with a `levenshteinDistance(a: string, b: string): number` function using single-row DP.
  _Requirements: 2.5_
- [x] 2.2 Create `src/query/levenshtein.test.ts` with property-based tests (fast-check) for symmetry, identity, non-negativity, and triangle inequality, plus example-based tests for known string pairs.
  _Requirements: 2.5, 5.4_
  _Skills: `testing-patterns`_

## Task 3: Implement symbol resolver

- [x] 3.1 Create `src/query/symbol-resolver.ts` with the `SymbolResolution` type, `resolveSymbol()`, and `suggestSimilarSymbols()` functions as specified in the design.
  _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.5, 2.6_
- [x] 3.2 Create `src/query/symbol-resolver.test.ts` with unit tests covering: exact match returns `kind: "exact"`, fuzzy match returns `kind: "fuzzy"` with shortest name, not-found returns `kind: "not_found"` with suggestions, exact takes precedence over fuzzy, and suggestion limit of 5.
  _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 2.1, 2.2_
  _Skills: `testing-patterns`_
- [x] 3.3 Add property-based tests to `symbol-resolver.test.ts`: for all inputs, `resolveSymbol` returns a valid variant; suggestions length never exceeds limit; suggestions are ordered by ascending distance.
  _Requirements: 1.6, 2.1, 2.2_
  _Skills: `testing-patterns`_

## Task 4: Implement framework-aware layer classification

- [x] 4.1 Create `src/query/framework-layers.ts` with `TraceLayer` type, `FrameworkLayerConfig` interface, `FRAMEWORK_LAYER_MAP` (covering NestJS, Spring, Laravel, Express, Django, FastAPI, Next.js, ASP.NET), `GENERIC_LAYER_CONFIG` (matching current `LAYER_PATTERNS`), `detectFramework()`, and `classifyLayer()`.
  _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_
- [x] 4.2 Create `src/query/framework-layers.test.ts` with unit tests: each supported framework detects correctly from file paths, `classifyLayer` returns correct layers for framework-specific nodes, generic fallback matches current `LAYER_PATTERNS` behavior, unknown framework falls back to generic.
  _Requirements: 4.1, 4.2, 4.3, 4.4, 4.6_
  _Skills: `testing-patterns`_
- [x] 4.3 Add property-based tests to `framework-layers.test.ts`: for all nodes, `classifyLayer` returns a valid `TraceLayer` value; framework detection is deterministic.
  _Requirements: 4.6_
  _Skills: `testing-patterns`_

## Task 5: Integrate symbol resolver into query modules

- [x] 5.1 Update `context-retrieval.ts` to use `resolveSymbol` from `symbol-resolver.ts` instead of its local `findNode`, and return the appropriate empty result with resolution info when not found.
  _Requirements: 1.1, 1.2, 1.4, 1.5_
- [x] 5.2 Update `impact-analysis.ts` to use `resolveSymbol` from `symbol-resolver.ts` instead of its local `findNode`.
  _Requirements: 1.1, 1.2, 1.4, 1.5_
- [x] 5.3 Update `data-flow-trace.ts` to use `resolveSymbol` from `symbol-resolver.ts` instead of its local `findNode`, and replace `classifyLayer` and `LAYER_PATTERNS` with imports from `framework-layers.ts`. Accept an optional `framework` parameter in `executeDataFlowTrace`.
  _Requirements: 1.1, 1.2, 1.4, 1.5, 4.2, 4.3, 4.4, 4.5_

## Task 6: Update MCP tool handlers with fuzzy summaries

- [x] 6.1 Update `executeGetSymbolContext` in `tools.ts` to handle all three `SymbolResolution` variants: exact (current behavior), fuzzy (include "Fuzzy matched" in summary), not_found (include "Did you mean?" suggestions in summary).
  _Requirements: 2.1, 2.3, 2.4, 3.1, 3.3_
- [x] 6.2 Update `executeFindDependents` in `tools.ts` with the same three-variant handling.
  _Requirements: 2.1, 2.3, 2.4, 3.1, 3.3_
- [x] 6.3 Update `executeTraceDataFlow` in `tools.ts` to pass the `framework` parameter through to `executeDataFlowTrace`, and add three-variant handling.
  _Requirements: 2.1, 2.3, 2.4, 3.1, 3.3, 4.2_
- [x] 6.4 Update `executeImpactAnalysisTool` in `tools.ts` with the same three-variant handling.
  _Requirements: 2.1, 2.3, 2.4, 3.1, 3.3_

## Task 7: Verify all tests pass

- [x] 7.1 Run `pnpm vitest --run` and verify all existing and new tests pass. Fix any regressions from the refactoring.
  _Requirements: 5.4_
