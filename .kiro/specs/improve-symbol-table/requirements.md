# Requirements: Symbol Table

Part of the [Symbol Table Design](./design.md).

## Requirement 1: SymbolDefinition Type

**User Story**: As a Phase 3 resolution context consumer, I need a `SymbolDefinition` type that carries resolution metadata (parameterCount, returnType, ownerId) so I can perform heritage resolution without losing information.

### Acceptance Criteria

- 1.1: `SymbolDefinition` interface is exported from `src/indexer/resolution/symbol-table.ts`
- 1.2: `SymbolDefinition` has required readonly fields: `nodeId: string`, `filePath: string`, `type: string`
- 1.3: `SymbolDefinition` has optional readonly fields: `parameterCount?: number`, `returnType?: string`, `ownerId?: string`
- 1.4: `SymbolDefinition.nodeId` references `Symbol.id` from `src/types/index.ts` — `src/types/index.ts` is NOT modified

## Requirement 2: Updated add Signature

**User Story**: As a caller building a symbol table, I need `add(filePath, name, nodeId, type, metadata?)` so I can register symbols with their resolution metadata without wrapping them in a `Symbol` object.

### Acceptance Criteria

- 2.1: `SymbolTable.add` accepts `(filePath: string, name: string, nodeId: string, type: string, metadata?: { parameterCount?: number; returnType?: string; ownerId?: string })` signature
- 2.2: Calling `add` with metadata stores all provided metadata fields on the internal `SymbolDefinition`
- 2.3: Calling `add` without metadata leaves optional fields as `undefined`
- 2.4: `add` inserts into both `fileIndex` and `globalIndex` using the same `SymbolDefinition` object reference

## Requirement 3: lookupExactFull Method

**User Story**: As a Phase 3 resolution context, I need `lookupExactFull(filePath, name)` to retrieve the full `SymbolDefinition` (not just the nodeId) for same-file tier-1 resolution.

### Acceptance Criteria

- 3.1: `SymbolTable` interface exposes `lookupExactFull(filePath: string, name: string): SymbolDefinition | undefined`
- 3.2: `lookupExactFull` returns the full `SymbolDefinition` for a registered (filePath, name) pair
- 3.3: `lookupExactFull` returns `undefined` for an unknown (filePath, name) pair
- 3.4: The object returned by `lookupExactFull` is the same reference as the matching entry in `lookupFuzzy` results

## Requirement 4: Updated lookupExact Return Type

**User Story**: As a caller using `lookupExact` for fast nodeId-only lookups, I need it to return `string | undefined` (the nodeId) rather than a full Symbol object.

### Acceptance Criteria

- 4.1: `lookupExact(filePath, name)` returns `string | undefined` (the `nodeId`)
- 4.2: `lookupExact` returns the correct `nodeId` for a registered symbol
- 4.3: `lookupExact` returns `undefined` for an unknown (filePath, name) pair

## Requirement 5: Updated lookupFuzzy Return Type

**User Story**: As a caller performing global name lookups, I need `lookupFuzzy` to return `SymbolDefinition[]` so I can access resolution metadata on each candidate.

### Acceptance Criteria

- 5.1: `lookupFuzzy(name)` returns `SymbolDefinition[]`
- 5.2: `lookupFuzzy` returns all definitions across all files that share the given name
- 5.3: `lookupFuzzy` returns `[]` for an unknown name (never throws)

## Requirement 6: Updated buildSymbolTable Helper

**User Story**: As a Phase 3 pipeline consumer, I need `buildSymbolTable(symbols: Symbol[])` to use the new `add` signature so existing callers in `index.ts` continue to work without modification.

### Acceptance Criteria

- 6.1: `buildSymbolTable` accepts `Symbol[]` and returns `SymbolTable`
- 6.2: For each symbol, `buildSymbolTable` calls `table.add(sym.location.filePath, sym.name, sym.id, sym.kind)`
- 6.3: `buildSymbolTable([])` returns an empty table with `getStats()` returning `{ fileCount: 0, globalSymbolCount: 0 }`
- 6.4: Existing callers in `src/indexer/resolution/index.ts` require no changes after the wrapper is updated

## Requirement 7: Internal Index Consistency

**User Story**: As a maintainer, I need both indexes to share the same `SymbolDefinition` object reference so there is zero extra memory overhead.

### Acceptance Criteria

- 7.1: The `SymbolDefinition` stored in `fileIndex[filePath][name]` is the same object (`Object.is`) as the entry in `globalIndex[name]`
- 7.2: `clear()` empties both `fileIndex` and `globalIndex`
- 7.3: `getStats().fileCount` equals the number of distinct `filePath` values added
- 7.4: `getStats().globalSymbolCount` equals the number of distinct `name` values added

## Requirement 8: File Size and Type Safety

**User Story**: As a maintainer, I need the implementation to stay under 250 lines and use no `any` types so it remains readable and type-safe.

### Acceptance Criteria

- 8.1: `src/indexer/resolution/symbol-table.ts` stays under 250 lines
- 8.2: No `any` type is used anywhere in the file — use `SymbolDefinition` throughout
- 8.3: All public functions have explicit return type annotations

## Requirement 9: Test Coverage

**User Story**: As a developer, I need unit tests and a property-based test in `src/indexer/resolution/symbol-table.test.ts` so I can verify correctness and catch regressions.

### Acceptance Criteria

- 9.1: All 14 unit test cases listed in the design pass
- 9.2: The property-based test using `fast-check` passes with `numRuns: 100`
- 9.3: All existing tests in `src/indexer/resolution/index.test.ts` continue to pass
- 9.4: `pnpm vitest --run` exits 0
