# Requirements: Obsidian Export

## Requirement 1: CLI Command Registration

The system shall provide a `typocop obsidian` CLI command as a standalone subcommand.

### Acceptance Criteria
- 1.1 The command is registered as `obsidian` in the Commander.js program (not a flag on `parse`)
- 1.2 The `CLICommand` union type includes `{ type: "obsidian"; config: ObsidianExportConfig }`
- 1.3 The command accepts `--out <path>` option (default: `./.typocop-obsidian`)
- 1.4 The command accepts `--verbose` flag (default: false)
- 1.5 Running `typocop obsidian --help` displays usage information

## Requirement 2: Graph Data Reading

The system shall read all graph data from Neo4j without modifying it.

### Acceptance Criteria
- 2.1 Fetches all Symbol nodes with the configured prefix
- 2.2 Fetches all Cluster nodes with the configured prefix
- 2.3 Fetches all Process nodes with the configured prefix
- 2.4 Fetches all relationships (CALLS, IMPORTS, INHERITS, IMPLEMENTS) with prefix
- 2.5 Fetches cluster membership edges (CONTAINS)
- 2.6 Fetches process step edges (HAS_STEP) with order property
- 2.7 Does NOT create, update, or delete any graph data
- 2.8 Uses a single read transaction for consistency
- 2.9 Handles empty graph gracefully (prints message, exits with code 0)

## Requirement 3: Symbol File Generation

The system shall generate one markdown file per source file, containing all symbols from that file.

### Acceptance Criteria
- 3.1 Vault file path mirrors source file path with `.md` extension (e.g., `src/cli/parser.ts` → `src/cli/parser.md`)
- 3.2 Each file includes YAML frontmatter with: source_file, symbol_count, clusters, last_exported
- 3.3 Each symbol section includes: kind, visibility, line range, signature, cluster (as wikilink), caller count
- 3.4 Outgoing calls rendered as wikilinks: `**Calls**: [[symbolName]], ...`
- 3.5 Incoming calls rendered as wikilinks: `**Called by**: [[symbolName]], ...`
- 3.6 Symbols are grouped by their source file path, not by type/kind

## Requirement 4: Cluster Export

The system shall generate cluster index files with member listings.

### Acceptance Criteria
- 4.1 Each cluster produces a file at `_clusters/{slugified-name}.md`
- 4.2 Cluster files include YAML frontmatter: type, category, confidence, symbol_count
- 4.3 Cluster files list all member symbols as wikilinks
- 4.4 A `_clusters/_index.md` file lists all clusters with links

## Requirement 5: Process Export with Mermaid Diagrams

The system shall generate process files with data flow Mermaid diagrams.

### Acceptance Criteria
- 5.1 Each process produces a file at `_processes/{slugified-name}.md`
- 5.2 Process files include YAML frontmatter: type, entry_point, step_count
- 5.3 Process files include a Mermaid `graph LR` diagram showing step-to-step flow
- 5.4 Process files list all steps in order with wikilinks to symbol names
- 5.5 A `_processes/_index.md` file lists all processes with links

## Requirement 6: Navigation Index

The system shall generate a top-level navigation index.

### Acceptance Criteria
- 6.1 A `_index.md` file is generated at the vault root
- 6.2 The index includes summary statistics (symbol count, cluster count, process count)
- 6.3 The index links to `_clusters/_index.md` and `_processes/_index.md`
- 6.4 The index lists source directories for browsing

## Requirement 7: Wikilink Cross-Referencing

The system shall use Obsidian wikilinks for all cross-references.

### Acceptance Criteria
- 7.1 Symbol references use `[[symbolName]]` format
- 7.2 Cluster references use `[[clusterName]]` format
- 7.3 All wikilink targets correspond to actual symbol or cluster names in the vault
- 7.4 No broken wikilinks are generated (targets must exist in the exported data)

## Requirement 8: Vault Writing

The system shall write the vault to the file system cleanly.

### Acceptance Criteria
- 8.1 Output directory is created if it does not exist
- 8.2 Previous output at the same path is completely removed before writing
- 8.3 Directory structure mirrors source file paths
- 8.4 Reports statistics on completion: files written, total bytes
- 8.5 Output path is validated against directory traversal

## Requirement 9: Error Handling

The system shall handle errors gracefully.

### Acceptance Criteria
- 9.1 Neo4j connection failure: retry with exponential backoff (max 3 attempts)
- 9.2 Empty graph: print informative message and exit with code 0
- 9.3 Unwritable output path: throw descriptive error with path
- 9.4 Partial write failure: log failed file, continue with remaining files
