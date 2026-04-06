# Requirements: Resolution Context

## Requirement 1 — 4-Tier Resolution Strategy

**User Story:** As the Phase 3 pipeline, I need a single `resolve(name, fromFile)` API that applies a 4-tier strategy so that every resolved candidate carries an accurate confidence score.

### Acceptance Criteria

1.1 `resolve(name, fromFile)` returns `TieredCandidates | null` — never throws for valid string inputs.

1.2 Tier 1 (same-file): when `symbolTable.lookupExactFull(fromFile, name)` returns a definition, `resolve` returns `{ candidates: [def], tier: 'same-file' }` with confidence 0.95.

1.3 Tier 2a-named (named binding chain): when `namedImportMap` contains a chain from `fromFile` to a definition, `resolve` returns `{ candidates, tier: 'import-scoped' }` with confidence 0.90. This tier is evaluated before the `allDefs.length === 0` early-return.

1.4 Tier 2a (import-scoped): when `importMap.get(fromFile)` contains the definition's file path, `resolve` returns `{ candidates, tier: 'import-scoped' }` with confidence 0.90.

1.5 Tier 2b (package-scoped): when `packageMap.get(fromFile)` contains a dir suffix matching the definition's file path, `resolve` returns `{ candidates, tier: 'import-scoped' }` with confidence 0.90.

1.6 Tier 3 (global): when no higher tier matches, `resolve` returns `{ candidates: allDefs, tier: 'global' }` with confidence 0.50. All candidates are returned — consumers must check `candidates.length`.

1.7 `resolve` returns `null` when `lookupFuzzy(name)` returns an empty array and no named binding chain resolves.

1.8 When non-null, `candidates.length >= 1` always holds.

---

## Requirement 2 — Confidence Constants

**User Story:** As a consumer of `ResolutionContext`, I need exported confidence constants so that I can compute `Relationship` confidence without hardcoding magic numbers.

### Acceptance Criteria

2.1 `TIER_CONFIDENCE` is exported as `Record<ResolutionTier, number>`.

2.2 Values are: `'same-file': 0.95`, `'import-scoped': 0.90`, `'global': 0.50`.

2.3 `ResolutionTier` is exported as a string union type: `'same-file' | 'import-scoped' | 'global'`.

2.4 `TieredCandidates` is exported as a readonly interface with `candidates: readonly SymbolDefinition[]` and `tier: ResolutionTier`.

---

## Requirement 3 — Per-File Cache

**User Story:** As the Phase 3 pipeline processing large repos, I need a per-file resolution cache so that repeated lookups of the same name within one file's processing pass are O(1).

### Acceptance Criteria

3.1 `enableCache(filePath)` activates the cache for `filePath` and clears any previous entries.

3.2 While the cache is active, a second call to `resolve(name, filePath)` for the same `name` and `filePath` returns the cached result without calling `resolveUncached`.

3.3 The cache is only active for the file passed to `enableCache`. Calls with a different `fromFile` bypass the cache entirely.

3.4 `clearCache()` deactivates the cache. The internal `Map` instance is retained (not garbage-collected) to reduce allocation pressure on large repos.

3.5 `getStats()` returns `cacheHits` and `cacheMisses` counters that accurately reflect cache activity since the last `clear()` call.

---

## Requirement 4 — Data Access for Pipeline Wiring

**User Story:** As the Phase 3 pipeline, I need direct access to the underlying maps so that import-processor and parsing-processor can populate them without going through the resolution API.

### Acceptance Criteria

4.1 `ResolutionContext` exposes `symbols: SymbolTable` as a readonly property.

4.2 `ResolutionContext` exposes `importMap: ImportMap`, `packageMap: PackageMap`, and `namedImportMap: NamedImportMap` as mutable references.

4.3 Mutations to the exposed maps are immediately visible to subsequent `resolve()` calls.

---

## Requirement 5 — Named Binding Chain (`walkBindingChain`)

**User Story:** As the resolution algorithm, I need to follow aliased import chains so that `import { User as U }` in file A correctly resolves to the `User` definition in file C even when B only re-exports it.

### Acceptance Criteria

5.1 `walkBindingChain` follows re-export chains up to a maximum depth of 5.

5.2 `walkBindingChain` detects circular references via a visited set and returns `null` when a cycle is detected.

5.3 `walkBindingChain` returns `null` (not an empty array) when the chain breaks.

5.4 `walkBindingChain` accepts the pre-fetched `allDefs` array (complete `lookupFuzzy` result) to avoid redundant global lookups at depth 0.

---

## Requirement 6 — TypeScript Strict Mode & Code Quality

**User Story:** As a maintainer, I need the implementation to follow project coding standards so that it integrates cleanly with the rest of the codebase.

### Acceptance Criteria

6.1 No `any` — use `unknown` with type guards where needed.

6.2 All exported functions have explicit return type annotations.

6.3 `resolution-context.ts` stays under 250 lines. If it would exceed 250 lines, `walkBindingChain` and `isFileInPackageDir` are extracted to `named-binding.ts`.

6.4 Named exports only — no default exports.

6.5 `createResolutionContext` is the sole factory function; no class-based implementation.

---

## Requirement 7 — Phase 3 Integration

**User Story:** As the Phase 3 pipeline, I need `ResolutionContext` wired into `resolveHints` so that the tiered strategy replaces the current ad-hoc `symbolMap` + `symbolTable` lookups.

### Acceptance Criteria

7.1 `src/indexer/resolution/index.ts` imports and uses `createResolutionContext` in `resolveHints`.

7.2 The existing `resolveReferences` public API signature is unchanged.

7.3 `enableCache` is called once per file before processing its hints; `clearCache` is called after.

7.4 All existing tests in `index.test.ts` continue to pass after the integration.

---

## Requirement 8 — Tests

**User Story:** As a developer, I need co-located tests covering all tiers, the cache, and correctness properties so that regressions are caught immediately.

### Acceptance Criteria

8.1 `resolution-context.test.ts` is co-located with `resolution-context.ts`.

8.2 All 7 property-based tests (RC-1 through RC-7) from `design-correctness.md` are implemented using `fast-check`.

8.3 All 7 example-based tests (RC-E1 through RC-E7) from `design-correctness.md` are implemented using `vitest`.

8.4 `named-binding.ts` has its own unit tests covering the circular reference and depth-limit edge cases.

8.5 All tests pass with `pnpm vitest --run`.
