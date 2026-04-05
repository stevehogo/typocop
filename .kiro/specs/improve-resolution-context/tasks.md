# Tasks: Resolution Context

## Task List

- [x] 1. Create `named-binding.ts` with `walkBindingChain` and `isFileInPackageDir`
  _Skills: `typescript-expert`, `clean-code`
  - [x] 1.1 Define `NamedImportBinding` interface (sourcePath, exportedName)
  - [x] 1.2 Implement `walkBindingChain` with max-depth 5 and circular-reference guard
  - [x] 1.3 Implement `isFileInPackageDir` helper
  - [x] 1.4 Export all three from `named-binding.ts` (named exports only)
  > Primary new file. `symbol-table.ts` is already fully implemented — do not recreate it.

- [x] 2. Write unit tests for `named-binding.ts`
  _Skills: `testing-patterns`, `tdd-workflow`
  - [x] 2.1 Test `walkBindingChain` resolves a 2-hop chain (A→B→C)
  - [x] 2.2 Test `walkBindingChain` returns null on circular reference (A→B→A)
  - [x] 2.3 Test `walkBindingChain` returns null when chain depth exceeds 5
  - [x] 2.4 Test `walkBindingChain` returns null when binding is missing at any hop
  - [x] 2.5 Test `isFileInPackageDir` matches mid-path and suffix patterns

- [x] 3. Implement `resolution-context.ts`
  _Skills: `typescript-expert`, `clean-code`, `nodejs-best-practices`
  - [x] 3.1 Define and export `ResolutionTier`, `TieredCandidates`, `ResolutionStats`, `ImportMap`, `PackageMap`, `NamedImportMap`
  - [x] 3.2 Export `TIER_CONFIDENCE` constant with values 0.95 / 0.90 / 0.50
  - [x] 3.3 Define `ResolutionContext` interface with `resolve`, map accessors, cache lifecycle, `getStats`, `clear`
  - [x] 3.4 Implement `resolveUncached` with all 4 tiers in correct order (Tier 1 → 2a-named → 2a → 2b → 3)
  - [x] 3.5 Implement `resolve` as cache wrapper around `resolveUncached`
  - [x] 3.6 Implement `enableCache` / `clearCache` with Map-instance reuse
  - [x] 3.7 Implement `getStats` and `clear`
  - [x] 3.8 Export `createResolutionContext` factory function; use `createSymbolTable()` internally (already implemented in `symbol-table.ts`)
  - [x] 3.9 Verify file stays under 250 lines; extract helpers to `named-binding.ts` if needed
  > Primary new file. Import `createSymbolTable` from `./symbol-table.js` — do not reimplement it.

- [x] 4. Write property-based and unit tests for `resolution-context.ts`
  _Skills: `testing-patterns`, `tdd-workflow`, `typescript-expert`
  - [x] 4.1 Property RC-1: non-null result always has non-empty candidates
  - [x] 4.2 Property RC-2: Tier 1 returns exactly one candidate from same file
  - [x] 4.3 Property RC-3: Tier 2a candidates are all in `importMap[fromFile]`
  - [x] 4.4 Property RC-4: Tier 3 returns all `lookupFuzzy` candidates when no maps populated
  - [x] 4.5 Property RC-5: cache hit returns identical result to uncached
  - [x] 4.6 Property RC-6: `cacheHits + cacheMisses = total calls` when cache active
  - [x] 4.7 Property RC-7: `resolve()` never mutates the symbol table
  - [x] 4.8 Example RC-E1: `TIER_CONFIDENCE` values match spec
  - [x] 4.9 Example RC-E2: named binding chain resolves aliased import (A→B→C)
  - [x] 4.10 Example RC-E3: circular chain returns null
  - [x] 4.11 Example RC-E4: chain depth > 5 returns null
  - [x] 4.12 Example RC-E5: `clear()` resets all state to zero
  - [x] 4.13 Example RC-E6: `enableCache` switches file and invalidates previous cache
  - [x] 4.14 Example RC-E7: Tier 2b package-scoped resolution

- [x] 5. Wire `ResolutionContext` into Phase 3 (`index.ts`)
  _Skills: `typescript-expert`, `architecture`, `clean-code`
  - [x] 5.1 Import `createResolutionContext` in `src/indexer/resolution/index.ts`
  - [x] 5.2 Refactor `resolveHints` to use `ResolutionContext.resolve()` instead of ad-hoc `symbolMap` + `symbolTable` lookups
        > `resolveHints` currently handles 4 hint kinds: `import`, `call`, `inherits`, `implements`. All 4 must continue working after the refactor.
  - [x] 5.3 Call `enableCache(filePath)` before processing each file's hints; call `clearCache()` after
  - [x] 5.4 Preserve the existing `resolveReferences` public API signature unchanged
  - [x] 5.5 Confirm all existing tests in `index.test.ts` still pass
        > `resolveReferences` is called by `runIndexingPipeline` (`src/indexer/pipeline.ts:111`) and `executeIndexingPipeline` (`src/cli/executor.ts:48`) — neither caller must break.

- [x] 6. Verify full test suite passes
  _Skills: `testing-patterns`
  - [x] 6.1 Run `pnpm vitest --run src/indexer/resolution/` and confirm zero failures
  - [x] 6.2 Run `pnpm vitest --run` (full suite) and confirm no regressions
