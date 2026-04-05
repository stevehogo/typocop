# Tasks: Symbol Table

Part of the [Symbol Table Design](./design.md).

## Task List

- [x] 1. Update symbol-table.ts — types and interface
  _Skills: `typescript-expert`, `clean-code`
  - [x] 1.1 Add `SymbolDefinition` interface with `nodeId`, `filePath`, `type`, and optional `parameterCount`, `returnType`, `ownerId` fields (all `readonly`)
  - [x] 1.2 Replace `add(symbol: Symbol)` with `add(filePath, name, nodeId, type, metadata?)` in the `SymbolTable` interface
  - [x] 1.3 Add `lookupExactFull(filePath: string, name: string): SymbolDefinition | undefined` to the `SymbolTable` interface
  - [x] 1.4 Update `lookupExact` return type in the interface from `Symbol | undefined` to `string | undefined`
  - [x] 1.5 Update `lookupFuzzy` return type in the interface from `Symbol[]` to `SymbolDefinition[]`

- [x] 2. Update createSymbolTable implementation
  _Skills: `typescript-expert`, `clean-code`
  - [x] 2.1 Change `fileIndex` type from `Map<string, Map<string, Symbol>>` to `Map<string, Map<string, SymbolDefinition>>`
  - [x] 2.2 Change `globalIndex` type from `Map<string, Symbol[]>` to `Map<string, SymbolDefinition[]>`
  - [x] 2.3 Rewrite `add` to construct a `SymbolDefinition` from its parameters and insert the same object reference into both indexes
  - [x] 2.4 Update `lookupExact` to return `def.nodeId` (string) instead of the full object
  - [x] 2.5 Implement `lookupExactFull` to return the full `SymbolDefinition` from `fileIndex`
  - [x] 2.6 Update `lookupFuzzy` to return `SymbolDefinition[]` from `globalIndex`
  - [x] 2.7 Remove the `import type { Symbol }` import (no longer needed in the implementation body; keep only for `buildSymbolTable`)

- [x] 3. Update buildSymbolTable helper
  _Skills: `typescript-expert`
  - [x] 3.1 Update `buildSymbolTable` to call `table.add(sym.location.filePath, sym.name, sym.id, sym.kind)` for each symbol
  - [x] 3.2 Verify `src/indexer/resolution/index.ts` requires no changes (it only calls `buildSymbolTable`, not `add` directly)

- [x] 4. Write unit tests
  _Skills: `testing-patterns`, `tdd-workflow`
  - [x] 4.1 Create `src/indexer/resolution/symbol-table.test.ts` with `describe("createSymbolTable")` block
  - [x] 4.2 Test: `add + lookupExact` returns `nodeId` for registered symbol
  - [x] 4.3 Test: `add + lookupExactFull` returns full `SymbolDefinition`
  - [x] 4.4 Test: `lookupExact` returns `undefined` for unknown name
  - [x] 4.5 Test: `lookupExactFull` returns `undefined` for unknown name
  - [x] 4.6 Test: `lookupFuzzy` returns all definitions across files
  - [x] 4.7 Test: `lookupFuzzy` returns `[]` for unknown name
  - [x] 4.8 Test: `add` with metadata stores `parameterCount`, `returnType`, `ownerId`
  - [x] 4.9 Test: `add` without metadata leaves optional fields `undefined`
  - [x] 4.10 Test: two symbols with same name in different files — `lookupExact` is file-scoped
  - [x] 4.11 Test: two symbols with same name in different files — `lookupFuzzy` returns both
  - [x] 4.12 Test: `lookupExactFull` and matching `lookupFuzzy` entry are the same object reference (`Object.is`)
  - [x] 4.13 Test: `clear` empties both indexes
  - [x] 4.14 Test: `getStats` reflects correct `fileCount` and `globalSymbolCount`
  - [x] 4.15 Add `describe("buildSymbolTable")` block: builds table from `Symbol[]` using `Symbol.id` as `nodeId`
  - [x] 4.16 Add `describe("buildSymbolTable")` block: returns empty table for empty array

- [x] 5. Write property-based test
  _Skills: `testing-patterns`
  - [x] 5.1 [PBT] Add property test: for any `Symbol[]`, all `nodeId` values returned by `lookupFuzzy` belong to the input symbol id set

- [x] 6. Verify no regressions
  _Skills: `testing-patterns`
  - [x] 6.1 Run `pnpm vitest --run src/indexer/resolution/` and confirm all tests pass including existing `index.test.ts`
  - [x] 6.2 Confirm `symbol-table.ts` is under 250 lines
  - [x] 6.3 Run `pnpm vitest --run` (full suite) and confirm exit 0
