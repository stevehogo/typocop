# Tasks: Language Config Loaders

## Overview

Implement `src/indexer/language-config.ts` — five async loaders that read language-specific
project config files and return structured data for Phase 3 import resolution.

## Tasks

- [ ] 1. Define types and module skeleton
  _Skills: `typescript-expert`, `clean-code`
  - [ ] 1.1 Create `src/indexer/language-config.ts` with all five exported interfaces:
        `TsconfigPaths`, `ComposerConfig`, `GoModuleConfig`, `CSharpProjectConfig`,
        `SwiftPackageConfig`, and the aggregate `LanguageConfigs`
        _Requirements: 7.1, 7.2, 7.3_
  - [ ] 1.2 Apply `ReadonlyMap<K, V>` on all map fields and `readonly` on all interface fields
        _Requirements: 7.3_
  - [ ] 1.3 Add stub exports for all six public functions with explicit return type annotations
        (bodies throw `new Error("not implemented")`)
        _Requirements: 7.2_
  - [ ] 1.4 Verify file compiles under `"strict": true` with no errors
        _Requirements: 7.4_

- [ ] 2. Implement `loadTsconfigPaths`
  _Skills: `typescript-expert`, `error-handling-patterns`, `nodejs-best-practices`
  - [ ] 2.1 Implement `stripJsonComments` helper (strips `//` single-line and `/* */` multi-line)
        _Requirements: 1.2_
  - [ ] 2.2 Iterate candidates `["tsconfig.json", "tsconfig.app.json", "tsconfig.base.json"]`,
        returning the first with a non-empty `compilerOptions.paths`
        _Requirements: 1.1_
  - [ ] 2.3 Normalise glob patterns: strip trailing `*` from alias keys and target values
        _Requirements: 1.3_
  - [ ] 2.4 Default `baseUrl` to `"."` when `compilerOptions.baseUrl` is absent
        _Requirements: 1.4_
  - [ ] 2.5 Return `null` on missing file, empty paths map, or parse error; never throw
        _Requirements: 1.5, 1.6_
  - [ ]* 2.6 Write unit tests: JSON comments stripped, glob normalisation, candidate fallback
        order, returns `null` when all candidates absent
        _Requirements: 1.1, 1.2, 1.3, 1.5_
  - [ ]* 2.7 Write property test — Property 1: alias keys never end with `*`
        _Requirements: 1.3_
  - [ ]* 2.8 Write property test — Property 2: alias values never end with `*`
        _Requirements: 1.3_

- [ ] 3. Implement `loadComposerConfig`
  _Skills: `typescript-expert`, `error-handling-patterns`
  - [ ] 3.1 Read and parse `composer.json`; merge `autoload["psr-4"]` and
        `autoload-dev["psr-4"]` (dev entries override prod for the same key)
        _Requirements: 2.1, 2.2_
  - [ ] 3.2 Normalise namespace keys (strip trailing `\`) and directory values
        (strip trailing `/`, convert `\` to `/`)
        _Requirements: 2.3, 2.4_
  - [ ] 3.3 Return `null` on missing file or parse error; never throw
        _Requirements: 2.5, 2.6_
  - [ ]* 3.4 Write unit tests: merges autoload + autoload-dev, normalises keys and values,
        returns `null` when absent
        _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
  - [ ]* 3.5 Write property test — Property 3: PSR-4 namespace keys never end with `\`
        _Requirements: 2.3_
  - [ ]* 3.6 Write property test — Property 4: PSR-4 directory values never end with `/`
        _Requirements: 2.4_

- [ ] 4. Implement `loadGoModulePath`
  _Skills: `typescript-expert`, `error-handling-patterns`
  - [ ] 4.1 Read `go.mod` and extract the module path from the first `module <path>` line
        via regex `/^module\s+(\S+)/m`
        _Requirements: 3.1, 3.2_
  - [ ] 4.2 Return `null` when file is absent or contains no `module` directive; never throw
        _Requirements: 3.4, 3.5_
  - [ ]* 4.3 Write unit tests: extracts module path, returns `null` when absent
        _Requirements: 3.1, 3.2, 3.4_
  - [ ]* 4.4 Write property test — Property 5: `modulePath` is non-empty when loader
        returns non-null
        _Requirements: 3.3_

- [ ] 5. Implement `loadCSharpProjectConfig`
  _Skills: `typescript-expert`, `error-handling-patterns`, `nodejs-best-practices`
  - [ ] 5.1 Implement BFS queue with `{ dir, depth }` entries; enforce `MAX_DEPTH = 5`
        and `MAX_DIRS = 100` bounds
        _Requirements: 4.1, 4.2_
  - [ ] 5.2 Skip directories named `node_modules`, `.git`, `bin`, `obj` during BFS
        _Requirements: 4.3_
  - [ ] 5.3 For each `.csproj` found, extract `<RootNamespace>` via regex; fall back to
        filename without extension when absent
        _Requirements: 4.4, 4.5_
  - [ ] 5.4 Compute `projectDir` as `path.relative(repoRoot, dir)` with `\` → `/`
        _Requirements: 4.6_
  - [ ] 5.5 Skip unreadable `.csproj` files and continue BFS; return `[]` when none found;
        never throw
        _Requirements: 4.7, 4.8, 4.9_
  - [ ]* 5.6 Write unit tests: extracts `<RootNamespace>`, falls back to filename, BFS
        depth/dir bounds enforced, forward-slash `projectDir`
        _Requirements: 4.1, 4.2, 4.4, 4.5, 4.6_
  - [ ]* 5.7 Write property test — Property 6: `projectDir` never contains `\`
        _Requirements: 4.6_

- [ ] 6. Implement `loadSwiftPackageConfig`
  _Skills: `typescript-expert`, `error-handling-patterns`
  - [ ] 6.1 Scan `Sources/`, `Package/Sources/`, and `src/` for subdirectories; build
        `targets` map: `entry.name → sourceDir/entry.name`
        _Requirements: 5.1, 5.2_
  - [ ] 6.2 Return `{ targets }` when at least one entry found; return `null` when none
        of the source directories exist or contain subdirectories; never throw
        _Requirements: 5.3, 5.4, 5.5_
  - [ ]* 6.3 Write unit tests: finds targets in all three source dirs, returns `null`
        when none exist
        _Requirements: 5.1, 5.3, 5.4_

- [ ] 7. Implement `loadLanguageConfigs` orchestrator
  _Skills: `typescript-expert`, `nodejs-best-practices`
  - [ ] 7.1 Run all five loaders concurrently via `Promise.all`; return `LanguageConfigs`
        with all five fields
        _Requirements: 6.1, 6.2_
  - [ ] 7.2 Ensure `csharp` field is always an array (never `null`); wrap entire function
        in try/catch to guarantee it never throws
        _Requirements: 6.3, 6.4_
  - [ ]* 7.3 Write unit tests: returns complete shape, `csharp` is always an array,
        never throws on non-existent path
        _Requirements: 6.2, 6.3, 6.4_
  - [ ]* 7.4 Write property test — Property 7: `loadLanguageConfigs` never throws for
        any string input
        _Requirements: 6.4_
  - [ ]* 7.5 Write property test — Property 8: result always has all five keys and
        `csharp` is always an array
        _Requirements: 6.2, 6.3_

- [ ] 8. Checkpoint — verify strict compliance and file size
  _Skills: `typescript-expert`
  - Confirm no `any` usage; all public functions have explicit return types
  - Confirm source file stays under 250 lines (split if needed)
  - Confirm test file stays under 500 lines (split if needed)
  - Ensure all tests pass: `pnpm vitest --run --reporter=basic src/indexer/language-config.test.ts`
  - _Requirements: 7.1, 7.2, 7.4, 7.5_

- [ ] 9. Wire into Phase 3
  _Skills: `typescript-expert`, `architecture`
  - [ ] 9.1 Add an optional `repoRoot?: string` parameter to `resolveReferences` in
        `src/indexer/resolution/index.ts`; when `repoRoot` is provided, call
        `loadLanguageConfigs(repoRoot)` at the top of `resolveHints` (the main code path)
        before the hint loop, so alias/namespace data is available during resolution
        _Requirements: 6.1, 6.5_
  - [ ] 9.2 Pass `LanguageConfigs` as a direct parameter into `resolveHints` rather than
        storing it on `ResolutionContext` — `createResolutionContext` signature stays
        unchanged; the context remains focused on symbol/import maps only
        _Requirements: 6.2_
  - [ ] 9.3 Update `src/indexer/pipeline.ts` to pass `sourcePath` as `repoRoot` through
        to `resolveReferences` at the Phase 3 call site (currently
        `resolveReferences(symbols, hints)` — change to
        `resolveReferences(symbols, hints, sourcePath)`)
        _Requirements: 6.1, 6.5_
  - [ ]* 9.4 Verify existing Phase 3 tests still pass after wiring:
        `pnpm vitest --run --reporter=basic src/indexer/resolution/index.test.ts`
        _Requirements: 6.1, 6.5_

## Notes

- Sub-tasks marked with `*` are optional and can be skipped for a faster MVP
- All loaders must never throw — I/O errors are caught and treated as "not found"
- Use `node:fs/promises` (`readFile`, `readdir`) and `node:path` (`join`, `relative`) only — no external packages
- Test file location: `src/indexer/language-config.test.ts` (co-located with source)
- Property-based tests use `fast-check`; unit tests use `vitest`
