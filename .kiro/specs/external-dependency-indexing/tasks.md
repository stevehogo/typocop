# Tasks: External Dependency Indexing

## Implementation Plan

### Phase A: Core Detection & Node Creation

- [ ] 1. Create `src/indexer/resolution/external-packages.ts`
  _Skills: `typescript-expert`, `clean-code`
  - [ ] 1.1 Implement `isExternalPackage(importPath: string, language: Language): boolean` with language-aware rules (PHP backslash, Rust self/super/crate, C system headers, Go, etc.)
  - [ ] 1.2 Implement `normalizePackageName(importPath: string, language: Language): string` with per-language strategies (PHP `\`, Java/C# `.`, Go 3-segment VCS, Rust `::`, C/C++ header root)
  - [ ] 1.3 Implement `buildAliases(packageName: string): string[]` stripping scope, namespace tail, and generating camelCase/PascalCase/stripped variants
  - [ ] 1.4 Implement `detectEcosystem(language: Language): PackageEcosystem`
  - [ ] 1.5 Implement `getOrCreateExtNode(packageName, language, extNodes): ExternalDependencyNode`
  - [ ] 1.6 Define `C_SYSTEM_HEADERS: ReadonlySet<string>` and `GO_VCS_HOSTS: ReadonlySet<string>` constants in `src/utils/limits.ts`

- [ ] 2. Update types in `src/types/index.ts`
  _Skills: `typescript-expert`
  - [ ] 2.1 Add `PackageEcosystem` union type (including `go_modules`)
  - [ ] 2.2 Add `ExternalDependencyNode` interface
  - [ ] 2.3 Extend `RelationType` with `"dependsOn"`
  - [ ] 2.4 Add `language: Language` field to `RawRelationshipHint` in `src/parser/extract-symbols.ts`

- [ ] 3. Write property tests for `external-packages.ts`
  _Skills: `testing-patterns`, `tdd-workflow`
  - [ ] 3.1 Property EDI-1: detection totality for TS/JS bare specifiers
  - [ ] 3.2 Property EDI-2: relative paths never external
  - [ ] 3.3 Property EDI-3: `node:` built-ins never external
  - [ ] 3.4 Property EDI-4: PHP backslash paths are external
  - [ ] 3.5 Property EDI-5: C system headers never external
  - [ ] 3.6 Property EDI-6: Rust `crate::`/`super::`/`self::` never external
  - [ ] 3.7 Property EDI-7: normalized name has no excess separators (all languages)
  - [ ] 3.8 Property EDI-8: aliases always include canonical name
  - [ ] 3.9 Property EDI-9: ID is stable and deterministic
  - [ ] 3.10 Property EDI-11: ecosystem is always a valid value

### Phase B: Parser Updates

- [ ] 4. Add Ruby import hint emission to `src/parser/queries.ts`
  _Skills: `typescript-expert`, `clean-code`
  - [ ] 4.1 Add `require` call capture to `RUBY_QUERIES` to emit import hints for bare gem names
  - [ ] 4.2 Add `require_relative` capture and mark as relative (will be filtered by `isExternalPackage`)
  - [ ] 4.3 Propagate `language` field through `extractSymbolsWithQueries` into each `RawRelationshipHint`

- [ ] 5. Write tests for Ruby import hint emission
  _Skills: `testing-patterns`
  - [ ] 5.1 `require 'rails'` emits an import hint with `targetName: "rails"`, `language: "ruby"`
  - [ ] 5.2 `require_relative './helper'` emits a hint that `isExternalPackage` classifies as internal

### Phase C: Resolution Phase Integration

- [ ] 6. Modify `resolveHints` in `src/indexer/resolution/index.ts`
  _Skills: `typescript-expert`, `clean-code`
  - [ ] 6.1 In the `"import"` case, call `isExternalPackage(hint.targetName, hint.language)` before existing resolution logic
  - [ ] 6.2 When external: call `getOrCreateExtNode` and emit a `dependsOn` relationship
  - [ ] 6.3 When internal: preserve existing resolution logic unchanged
  - [ ] 6.4 Return `{ relationships, extNodes }` from `resolveHints` (update return type)

- [ ] 7. Write integration tests for modified `resolveHints`
  _Skills: `testing-patterns`
  - [ ] 7.1 TS: `import neo4j from "neo4j-driver"` → `ext:neo4j-driver`, ecosystem `npm`
  - [ ] 7.2 PHP: `use Illuminate\Http\Request` → `ext:Illuminate`, ecosystem `composer`
  - [ ] 7.3 Java: `import com.neo4j.driver.Driver` → `ext:com.neo4j`, ecosystem `maven`
  - [ ] 7.4 Go: `import "github.com/neo4j/neo4j-go-driver/v5"` → `ext:github.com/neo4j/neo4j-go-driver`
  - [ ] 7.5 Rust: `use serde::Serialize` → `ext:serde`, ecosystem `cargo`
  - [ ] 7.6 Property EDI-12: no DEPENDS_ON for relative import hints
  - [ ] 7.7 Property EDI-13: DEPENDS_ON target always starts with `"ext:"`
  - [ ] 7.8 Internal imports still produce IMPORTS edges (regression)

### Phase D: Graph Store

- [ ] 8. Create `src/graph/external-dependency.ts`
  _Skills: `typescript-expert`, `nodejs-best-practices`
  - [ ] 8.1 Implement `storeExternalDependencies(session, nodes): Promise<void>` using MERGE on `ExternalDependency` label
  - [ ] 8.2 Implement `findExternalDependencyByAlias(session, query): Promise<GraphNode | null>` with case-insensitive regex on `name` and `aliases`

- [ ] 9. Write unit tests for `external-dependency.ts` (mocked session)
  _Skills: `testing-patterns`
  - [ ] 9.1 `storeExternalDependencies` calls MERGE with correct label and properties
  - [ ] 9.2 `findExternalDependencyByAlias` returns null when no match
  - [ ] 9.3 `findExternalDependencyByAlias` matches by alias case-insensitively (Property EDI-10)

### Phase E: Pipeline Integration

- [ ] 10. Update `src/indexer/pipeline.ts`
  _Skills: `typescript-expert`, `clean-code`
  - [ ] 10.1 Update `resolveReferences` call to capture returned `extNodes`
  - [ ] 10.2 Pass `extNodes` to `storeInDatabases`
  - [ ] 10.3 Call `storeExternalDependencies` and store `DEPENDS_ON` edges
  - [ ] 10.4 Include ext node count in pipeline stats

- [ ] 11. Write pipeline integration tests
  _Skills: `testing-patterns`, `nodejs-best-practices`
  - [ ] 11.1 TypeScript fixture with `neo4j-driver` import produces `ExternalDependency` node
  - [ ] 11.2 PHP fixture with `Illuminate\Http\Request` produces `ext:Illuminate` node
  - [ ] 11.3 Existing pipeline tests still pass (regression)

### Phase F: Query Engine

- [ ] 12. Extend impact analysis in `src/query/impact-analysis.ts`
  _Skills: `typescript-expert`, `clean-code`
  - [ ] 12.1 Before `findDependents`, call `findExternalDependencyByAlias`
  - [ ] 12.2 If matched, run `DEPENDS_ON` traversal query
  - [ ] 12.3 If not matched, fall through to existing logic (no regression)
  - [ ] 12.4 Merge results into existing `QueryResult` shape — no API surface change

- [ ] 13. Write tests for extended impact analysis
  _Skills: `testing-patterns`
  - [ ] 13.1 `impact_analysis("neo4j-driver")` returns all dependent symbols (EDI-14)
  - [ ] 13.2 `impact_analysis("Neo4j")` resolves via alias and returns same results
  - [ ] 13.3 `impact_analysis("Illuminate")` resolves PHP composer package
  - [ ] 13.4 `impact_analysis("createDriver")` still uses internal traversal (EDI-15)
  - [ ] 13.5 Risk level thresholds apply correctly to external dep results
