Part of the [Obsidian Export Design](./design.md).

# Correctness Properties & Testing

## Correctness Properties

1. **No duplicate vault paths**: For all rendered vaults, no two files share the same `relativePath`.
   - `∀ v ∈ renderVault(data).files: unique(v.relativePath)`

2. **Symbol coverage**: Every symbol in the graph appears in exactly one vault file.
   - `∀ s ∈ data.symbols: ∃! f ∈ vault.files: f contains s.name`

3. **Wikilink validity**: Every `[[target]]` wikilink references a symbol name that exists in the vault.
   - `∀ link ∈ extractWikilinks(vault): ∃ s ∈ data.symbols ∪ data.clusters: s.name === link`

4. **Cluster completeness**: Every cluster in the graph has a corresponding vault file.
   - `∀ c ∈ data.clusters: ∃ f ∈ vault.files: f.relativePath contains slugify(c.name)`

5. **Process completeness**: Every process in the graph has a corresponding vault file with a Mermaid diagram.
   - `∀ p ∈ data.processes: ∃ f ∈ vault.files: f.content contains "```mermaid"`

6. **Frontmatter validity**: Every symbol file has valid YAML frontmatter with `source_file` field.
   - `∀ f ∈ symbolFiles(vault): parseFrontmatter(f).source_file !== undefined`

7. **Path mirroring**: Vault file paths mirror source file paths with `.md` extension.
   - `∀ f ∈ symbolFiles(vault): f.relativePath ends with ".md"`

8. **Read-only graph access**: The export operation does not create, update, or delete any graph data.

9. **Slugify idempotence**: `slugify(slugify(x)) === slugify(x)` for all strings.

10. **sourcePathToVaultPath determinism**: Same input always produces same output, always ends in `.md`.

## Error Handling

### Empty Graph
- **Condition**: No symbols found in Neo4j
- **Response**: Print "No symbols found. Run 'typocop parse' first." and exit gracefully (code 0)

### Neo4j Connection Failure
- **Condition**: Cannot connect to Neo4j at configured URI
- **Response**: Retry with exponential backoff (max 3 attempts via existing `withRetry`)
- **Recovery**: If all retries fail, print error and exit with code 1

### Output Directory Not Writable
- **Condition**: Cannot create or write to the output directory
- **Response**: Throw descriptive error with the path and OS error
- **Recovery**: User must fix permissions or choose different output path

### Partial Write Failure
- **Condition**: Some files written, then a write fails mid-export
- **Response**: Log which file failed, attempt remaining files
- **Recovery**: Report partial success with count of files written vs. total

## Testing Strategy

### Unit Tests
- `renderSymbolFile` with various symbol configurations
- `renderProcessFile` with different step counts
- `sourcePathToVaultPath` with edge cases (nested paths, various extensions)
- `slugify` with special characters, unicode, spaces
- Mock Neo4j session for `fetchAllGraphData` tests

### Property-Based Tests (fast-check)
1. `renderVault` never produces duplicate file paths (for any valid GraphData)
2. Every symbol in input appears in exactly one output file
3. `sourcePathToVaultPath` always produces a `.md` extension
4. `slugify` is idempotent: `slugify(slugify(x)) === slugify(x)`
5. Wikilinks only reference names present in the symbol set or cluster names

### Integration Tests
- End-to-end: index a fixture project, run obsidian export, verify vault structure
- Verify generated markdown has valid YAML frontmatter
- Verify Mermaid syntax is well-formed
- Verify no invalid characters in filenames

## Performance Considerations

- Fetch all graph data in a single read transaction (not per-symbol queries)
- Use `Map` for O(1) lookups when building reverse indexes
- For graphs with 10,000+ symbols, consider batched Cypher queries

## Security Considerations

- Validate output path does not escape project root (no `../` traversal)
- Sanitize symbol names used in file paths
- Do not include credentials or env vars in exported markdown
- Mermaid node IDs are sanitized to prevent injection
