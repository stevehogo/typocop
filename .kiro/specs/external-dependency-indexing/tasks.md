# Tasks: External Dependency Indexing

## Implementation Plan

### Phase A: Types & Constants

- [x] 1. Update shared types and constants
  _Skills: `typescript-expert`, `clean-code`
  - [x] 1.1 Add `PackageEcosystem` type and `ExternalDependencyNode` interface to `src/types/index.ts`
  - [x] 1.2 Extend `RelationType` with `"dependsOn"` in `src/types/index.ts`
  - [x] 1.3 Add `language: Language` field to `RawRelationshipHint` in `src/parser/extract-symbols.ts`
  - [x] 1.4 Update all hint construction sites in `extractSymbolsWithQueries` to populate `language` from the function parameter
  - [x] 1.5 Add `C_SYSTEM_HEADERS: ReadonlySet<string>` constant to `src/utils/limits.ts` (POSIX/C++ standard headers)
  - [x] 1.6 Add `GO_VCS_HOSTS: ReadonlySet<string>` constant to `src/utils/limits.ts`

### Phase B: Core Detection Logic

- [x] 2. Create `src/indexer/resolution/external-packages.ts`
  _Skills: `typescript-expert`, `clean-code`
  - [x] 2.1 Implement `isExternalPackage(importPath, language)` — relative paths, `node:` built-ins, C system headers, Rust `crate::/super::/self::` → false; all other bare specifiers → true
  - [x] 2.2 Implement `normalizePackageName(importPath, language)` — PHP `\`, Java/C# `.` (2 segments), Go 3-segment VCS, Rust `::`, C/C++ header root, TS/JS scoped `@scope/pkg`
  - [x] 2.3 Implement `buildAliases(packageName)` — canonical + camelCase + PascalCase + stripped variants
  - [x] 2.4 Implement `detectEcosystem(language)` — language-to-ecosystem mapping
  - [x] 2.5 Implement `getOrCreateExtNode(packageName, language, extNodes)` — deduplicating factory

- [x] 3. Write property tests (`src/indexer/resolution/external-packages.pbt.test.ts`)
  _Skills: `testing-patterns`, `tdd-workflow`
  - [x] 3.1 EDI-P1: bare specifiers detected as external for TS/JS
  - [x] 3.2 EDI-P2: relative paths never external (all languages)
  - [x] 3.3 EDI-P3: `node:` built-ins never external
  - [x] 3.4 EDI-P4: PHP backslash paths are external
  - [x] 3.5 EDI-P5: C system headers never external
  - [x] 3.6 EDI-P6: Rust `crate::/super::/self::` never external
  - [x] 3.7 EDI-P7: normalized name has no trailing separators
  - [x] 3.8 EDI-P8: aliases always include canonical name
  - [x] 3.9 EDI-P9: ID is stable and deterministic
  - [x] 3.10 EDI-P11: ecosystem is always a valid value

### Phase C: Parser Updates (Ruby)

- [x] 4. Add Ruby import hint emission
  _Skills: `typescript-expert`, `clean-code`
  - [x] 4.1 Add `require` call capture to `RUBY_QUERIES` in `src/parser/queries.ts`
  - [x] 4.2 Add `require_relative` capture and mark as relative
  - [x] 4.3 Verify `language` field propagation through `extractSymbolsWithQueries`

- [x] 5. Write tests for Ruby import hints
  _Skills: `testing-patterns`
  - [x] 5.1 `require 'gem'` emits hint with `targetName: "gem"`, `language: "ruby"`
  - [x] 5.2 `require_relative './helper'` emits hint classified as internal by `isExternalPackage`

### Phase D: Resolution Phase Integration

- [x] 6. Modify `resolveHints` and `resolveReferences` in `src/indexer/resolution/index.ts`
  _Skills: `typescript-expert`, `clean-code`
  - [x] 6.1 Define `ResolveHintsResult` interface (`{ relationships, extNodes }`)
  - [x] 6.2 In `"import"` case: call `isExternalPackage(hint.targetName, hint.language)` before existing resolution
  - [x] 6.3 When external: call `getOrCreateExtNode`, emit `dependsOn` relationship, skip internal resolution
  - [x] 6.4 When internal: preserve existing resolution logic unchanged
  - [x] 6.5 Update `resolveHints` return type to `ResolveHintsResult`
  - [x] 6.6 Update `resolveReferences` to return `ResolveHintsResult` and propagate `extNodes`

- [x] 7. Write tests for modified resolution
  _Skills: `testing-patterns`
  - [x] 7.1 TS bare specifier → `ext:<pkg>` node, ecosystem `npm`
  - [x] 7.2 PHP backslash import → `ext:<vendor>` node, ecosystem `composer`
  - [x] 7.3 Java dot-separated → `ext:<top.two>` node, ecosystem `maven`
  - [x] 7.4 Go VCS module → `ext:<3-segment>` node, ecosystem `go_modules`
  - [x] 7.5 Rust crate → `ext:<crate>` node, ecosystem `cargo`
  - [x] 7.6 EDI-P12: no `dependsOn` for relative import hints
  - [x] 7.7 EDI-P13: `dependsOn` target always starts with `"ext:"`
  - [x] 7.8 Internal imports still produce `imports` edges (regression)

### Phase E: LadybugDB Schema & Storage

- [x] 8. Update LadybugDB schema in `src/db/ladybug-graph-adapter.ts`
  _Skills: `typescript-expert`, `nodejs-best-practices`
  - [x] 8.1 Add `ExternalDependency` node table to `initializeSchema()` (id, name, aliases, ecosystem)
  - [x] 8.2 Add `DEPENDS_ON` rel table (Symbol → ExternalDependency) to `initializeSchema()`
  - [x] 8.3 Add `DEPENDS_ON: ["Symbol", "ExternalDependency"]` to `REL_LABEL_MAP`

- [x] 9. Write unit tests for schema changes
  _Skills: `testing-patterns`
  - [x] 9.1 `initializeSchema` creates `ExternalDependency` table and `DEPENDS_ON` rel table
  - [x] 9.2 `createRelationship` with type `DEPENDS_ON` uses correct FROM/TO labels

### Phase F: Pipeline Integration

- [x] 10. Update `src/indexer/pipeline.ts`
  _Skills: `typescript-expert`, `clean-code`
  - [x] 10.1 Update `resolveReferences` call to destructure `{ relationships, extNodes }`
  - [x] 10.2 Store `ExternalDependency` nodes via `graphAdapter.createNode("ExternalDependency", ...)` with aliases as comma-separated string
  - [x] 10.3 Store `DEPENDS_ON` edges via `graphAdapter.createRelationship(sourceId, extId, "DEPENDS_ON")`
  - [x] 10.4 Add `externalDependencyCount` to `PipelineResult` and populate it

- [x] 11. Update `src/cli/executor.ts` for refresh and stats
  _Skills: `typescript-expert`, `clean-code`
  - [x] 11.1 Add `await graphAdapter.deleteNodesByLabel("ExternalDependency")` to refresh clearing
  - [x] 11.2 Add `await graphAdapter.deleteRelationshipsByType("DEPENDS_ON")` to refresh clearing
  - [x] 11.3 Include `ExternalDependency` count in clearing stats
  - [x] 11.4 Display `externalDependencyCount` in indexing stats output

- [x] 12. Write pipeline integration tests
  _Skills: `testing-patterns`, `nodejs-best-practices`
  - [x] 12.1 TS fixture with bare specifier produces `ExternalDependency` node in graph
  - [x] 12.2 PHP fixture with backslash import produces correct `ext:` node
  - [x] 12.3 Existing pipeline tests still pass (regression)

### Phase G: Query Engine

- [x] 13. Extend impact analysis in `src/query/impact-analysis.ts`
  _Skills: `typescript-expert`, `clean-code`
  - [x] 13.1 Implement `findExternalDependencyByAlias(graph, query)` — case-insensitive match on `name` and comma-separated `aliases`
  - [x] 13.2 In `executeImpactAnalysis`: before `findDependents`, call `findExternalDependencyByAlias`
  - [x] 13.3 If matched: run `DEPENDS_ON` traversal to find all dependent symbols
  - [x] 13.4 If not matched: fall through to existing `findDependents` (no regression)
  - [x] 13.5 Merge results into existing `ImpactAnalysisResult` shape

- [x] 14. Extend context retrieval in `src/query/context-retrieval.ts`
  _Skills: `typescript-expert`, `clean-code`
  - [x] 14.1 Add `DEPENDS_ON` traversal to find external deps a symbol depends on
  - [x] 14.2 Include external dependency names in the result's relationships array

- [x] 15. Update MCP tool summaries in `src/mcp/tools.ts`
  _Skills: `typescript-expert`, `clean-code`
  - [x] 15.1 In `executeImpactAnalysisTool`: detect when result came from external dep match and adjust summary text (e.g. "External package 'X': N dependent symbols")
  - [x] 15.2 In `executeFindDependents`: same external dep summary adjustment

- [x] 16. Write tests for query engine changes
  _Skills: `testing-patterns`
  - [x] 16.1 `findExternalDependencyByAlias` returns null when no match
  - [x] 16.2 `findExternalDependencyByAlias` matches by alias case-insensitively (EDI-P10)
  - [x] 16.3 `impact_analysis("<package>")` returns dependent symbols (EDI-P14)
  - [x] 16.4 Fuzzy alias match resolves approximate name to correct package
  - [x] 16.5 `impact_analysis("<internal-symbol>")` still uses internal traversal (EDI-P15)
  - [x] 16.6 Risk level thresholds apply correctly to external dep results
  - [x] 16.7 Context retrieval includes external deps in relationships

### Phase H: Obsidian Export

- [x] 17. Update obsidian export to include external dependencies
  _Skills: `typescript-expert`, `clean-code`
  - [x] 17.1 Add `ExportedExternalDependency` interface to `src/obsidian-export/graph-reader.ts`
  - [x] 17.2 Fetch `ExternalDependency` nodes in `fetchAllGraphData`
  - [x] 17.3 Fetch `DEPENDS_ON` edges and add to `GraphData.relationships`
  - [x] 17.4 Add `externalDependencies` and `dependsOnEdges` to `GraphData` interface
  - [x] 17.5 Render external dependency markdown files in `src/obsidian-export/renderer.ts` (name, ecosystem, aliases, dependent symbols)

- [x] 18. Write tests for obsidian export changes
  _Skills: `testing-patterns`
  - [x] 18.1 `fetchAllGraphData` includes external dependency nodes
  - [x] 18.2 `renderVault` produces files for external dependencies
  - [x] 18.3 Existing obsidian export tests still pass (regression)

## Codex session: codex resume 019dc9e6-65f8-7c91-8a11-f0eafbfc7c8e