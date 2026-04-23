# Tasks: Obsidian Export

- [x] 1. Extend CLI with `obsidian` command
  _Skills: `typescript-expert`, `clean-code`
  - [x] 1.1 Add `ObsidianExportConfig` interface and extend `CLICommand` union in `src/cli/parser.ts`
  - [x] 1.2 Register `obsidian` subcommand with `--out` and `--verbose` options in `parseArgs()`
  - [x] 1.3 Add `case "obsidian"` handler in `src/cli/executor.ts` that calls `executeObsidianExport`

- [x] 2. Implement GraphReader module
  _Skills: `typescript-expert`, `nodejs-best-practices`
  - [x] 2.1 Create `src/obsidian-export/graph-reader.ts` with `GraphData` and exported types
  - [x] 2.2 Implement `fetchAllGraphData(session, prefix)` — fetch symbols, clusters, processes
  - [x] 2.3 Implement relationship fetching (CALLS, IMPORTS, INHERITS, IMPLEMENTS) with name resolution
  - [x] 2.4 Implement cluster membership and process step map building
  - [x] 2.5 Handle empty graph case (return empty GraphData)

- [x] 3. Implement MarkdownRenderer — symbol files
  _Skills: `typescript-expert`, `clean-code`
  - [x] 3.1 Create `src/obsidian-export/renderer.ts` with `renderVault()` entry point
  - [x] 3.2 Implement `groupBy` utility and reverse-lookup map builders (symbolToCluster, callerCounts, etc.)
  - [x] 3.3 Implement `renderSymbolFile()` — YAML frontmatter + symbol sections with wikilinks
  - [x] 3.4 Implement `sourcePathToVaultPath()` and `slugify()` helpers

- [x] 4. Implement MarkdownRenderer — cluster and process files
  _Skills: `typescript-expert`, `clean-code`
  - [x] 4.1 Implement `renderClusterFile()` and `renderClusterIndex()`
  - [x] 4.2 Implement `renderProcessFile()` with Mermaid diagram generation
  - [x] 4.3 Implement `renderProcessIndex()`
  - [x] 4.4 Implement `renderNavigationIndex()` with summary statistics

- [x] 5. Implement VaultWriter module
  _Skills: `typescript-expert`, `nodejs-best-practices`, `error-handling-patterns`
  - [x] 5.1 Create `src/obsidian-export/vault-writer.ts` with `writeVault()` function
  - [x] 5.2 Implement directory cleanup (rm existing) and recursive mkdir
  - [x] 5.3 Implement file writing loop with byte counting
  - [x] 5.4 Implement output path validation (no directory traversal)

- [x] 6. Wire up executor and export orchestration
  _Skills: `typescript-expert`, `error-handling-patterns`
  - [x] 6.1 Create `src/obsidian-export/index.ts` re-exporting public API
  - [x] 6.2 Implement `executeObsidianExport()` orchestrator (connect → read → render → write)
  - [x] 6.3 Add spinner/progress output using `ora` and `chalk` (matching existing CLI style)

- [x] 7. Write unit tests for renderer
  _Skills: `testing-patterns`, `tdd-workflow`
  - [x] 7.1 Test `sourcePathToVaultPath` with various extensions and nested paths
  - [x] 7.2 Test `slugify` with special characters, unicode, empty strings
  - [x] 7.3 Test `renderSymbolFile` produces valid frontmatter and wikilinks
  - [x] 7.4 Test `renderProcessFile` produces valid Mermaid syntax
  - [x] 7.5 Test `renderVault` produces no duplicate file paths

- [x] 8. Write unit tests for graph-reader and vault-writer
  _Skills: `testing-patterns`, `tdd-workflow`
  - [x] 8.1 Test `fetchAllGraphData` with mocked Neo4j session (symbols, clusters, processes)
  - [x] 8.2 Test `fetchAllGraphData` with empty graph returns empty GraphData
  - [x] 8.3 Test `writeVault` creates correct directory structure (using temp dir)
  - [x] 8.4 Test output path validation rejects traversal patterns

- [ ]* 9. Write property-based tests
  _Skills: `testing-patterns`
  - [ ]*  9.1 Property: `renderVault` never produces duplicate file paths for any valid GraphData
  - [ ]*  9.2 Property: every symbol in input appears in exactly one output file
  - [ ]*  9.3 Property: `sourcePathToVaultPath` always produces `.md` extension
  - [ ]*  9.4 Property: `slugify` is idempotent
  - [ ]*  9.5 Property: all wikilinks reference names present in the symbol/cluster set
