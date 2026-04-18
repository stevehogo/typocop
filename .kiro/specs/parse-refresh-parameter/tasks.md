# Tasks: Parse Refresh Parameter

## Implementation Tasks

- [x] 1. Update CLIConfig Interface
  _Skills: `typescript-expert`, `clean-code`
  - [x] 1.1 Add `refresh?: boolean` field to CLIConfig interface in `src/cli/parser.ts`
  - [x] 1.2 Add JSDoc comments explaining the refresh field purpose
  - [x] 1.3 Verify no TypeScript errors

- [x] 2. Add --refresh Flag to Parse Command
  _Skills: `typescript-expert`, `clean-code`
  - [x] 2.1 Add `.option("-r, --refresh", "Clear and rebuild all graph and embeddings data", false)` to parse command
  - [x] 2.2 Pass `refresh` value from parsed options to CLIConfig
  - [x] 2.3 Test that `-r` short form works
  - [x] 2.4 Verify flag is optional and defaults to false

- [x] 3. Implement clearGraphData Function
  _Skills: `typescript-expert`, `error-handling-patterns`
  - [x] 3.1 Export `clearGraphData(session: Session, prefix: string): Promise<void>` in `src/graph/store.ts`
  - [x] 3.2 Delete all relationships in the graph first
  - [x] 3.3 Delete all nodes with prefixed labels
  - [x] 3.4 Log deletion counts
  - [x] 3.5 Handle errors gracefully and propagate them
  - [x] 3.6 Ensure function is idempotent

- [x] 4. Implement clearVectorData Function
  _Skills: `typescript-expert`, `error-handling-patterns`, `postgresql`
  - [x] 4.1 Export `clearVectorData(pool: Pool, prefix: string): Promise<void>` in `src/vector/index-store.ts`
  - [x] 4.2 Delete all embeddings for the prefix from pgvector table
  - [x] 4.3 Log deletion count
  - [x] 4.4 Handle errors gracefully and propagate them
  - [x] 4.5 Ensure function is idempotent
  - [x] 4.6 Properly release database connection

- [x] 5. Update executeIndexingPipeline Function
  _Skills: `typescript-expert`, `clean-code`
  - [x] 5.1 Add `refresh?: boolean` parameter to `executeIndexingPipeline` in `src/cli/executor.ts`
  - [x] 5.2 Call `clearGraphData()` if refresh is true
  - [x] 5.3 Call `clearVectorData()` if refresh is true
  - [x] 5.4 Ensure clearing happens before indexing pipeline starts
  - [x] 5.5 Skip clearing when refresh is false (default)
  - [x] 5.6 Add verbose logging for clearing operations

- [x] 6. Update executeCLI Function
  _Skills: `typescript-expert`, `clean-code`
  - [x] 6.1 Extract `refresh` from command.config in parse case
  - [x] 6.2 Pass `refresh` to `executeIndexingPipeline` call
  - [x] 6.3 Verify default behavior unchanged (refresh defaults to false)
  - [x] 6.4 Update error handling if needed

- [x] 7. Add User Feedback for Refresh Operation
  _Skills: `clean-code`, `nodejs-best-practices`
  - [x] 7.1 Add console output when refresh operation begins
  - [x] 7.2 Add console output when clearing completes with deletion counts
  - [x] 7.3 Update spinner messages to reflect refresh operation
  - [x] 7.4 Provide additional details in verbose mode

- [x] 8. Write Unit Tests for clearGraphData
  _Skills: `testing-patterns`, `tdd-workflow`
  - [x] 8.1 Test clearGraphData with mock Neo4j session in `src/graph/store.test.ts`
  - [x] 8.2 Test deletion of all relationships
  - [x] 8.3 Test deletion of all prefixed nodes
  - [x] 8.4 Test deletion counts are logged
  - [x] 8.5 Test Neo4j error handling
  - [x] 8.6 Test idempotency (safe to call twice)
  - [x] 8.7 Test that non-prefixed data is preserved

- [x] 9. Write Unit Tests for clearVectorData
  _Skills: `testing-patterns`, `tdd-workflow`
  - [x] 9.1 Test clearVectorData with mock PostgreSQL pool in `src/vector/index-store.test.ts`
  - [x] 9.2 Test deletion of all embeddings for prefix
  - [x] 9.3 Test deletion count is logged
  - [x] 9.4 Test PostgreSQL error handling
  - [x] 9.5 Test idempotency (safe to call twice)
  - [x] 9.6 Test that embeddings for other prefixes are preserved

- [x] 10. Write Unit Tests for CLI Parser
  _Skills: `testing-patterns`, `tdd-workflow`
  - [x] 10.1 Test parsing with --refresh flag in `src/cli/parser.test.ts`
  - [x] 10.2 Test parsing with -r short form
  - [x] 10.3 Test parsing without refresh flag (defaults to false)
  - [x] 10.4 Test help text includes refresh option
  - [x] 10.5 Test flag is optional

- [-] 11. Write Unit Tests for Executor
  _Skills: `testing-patterns`, `tdd-workflow`
  - [x] 11.1 Test executeCLI with refresh flag in `src/cli/executor.test.ts`
  - [x] 11.2 Test clearGraphData called when refresh is true
  - [x] 11.3 Test clearVectorData called when refresh is true
  - [x] 11.4 Test clearing skipped when refresh is false
  - [x] 11.5 Test indexing pipeline runs after clearing
  - [x] 11.6 Test errors during clearing propagate
  - [x] 11.7 Test user feedback is provided

- [-] 12. Write Integration Tests
  _Skills: `testing-patterns`, `tdd-workflow`
  - [x] 12.1 Test full parse with --refresh on sample project in `tests/integration/parse-refresh.test.ts`
  - [x] 12.2 Verify graph is empty before indexing
  - [x] 12.3 Verify graph is populated after indexing
  - [x] 12.4 Verify vector store is empty before indexing
  - [x] 12.5 Verify vector store is populated after indexing
  - [x] 12.6 Test incremental parse (without --refresh) preserves data
  - [x] 12.7 Verify refresh flag is optional
  - [x] 12.8 Verify statistics are accurate

- [-] 13. Write Property-Based Tests
  _Skills: `testing-patterns`
  - [x] 13.1 Test Property 1: Refresh clears all graph data in `src/cli/executor.pbt.test.ts`
  - [x] 13.2 Test Property 2: Refresh clears all vector data
  - [x] 13.3 Test Property 3: Refresh rebuilds complete graph
  - [x] 13.4 Test Property 4: Refresh rebuilds complete embeddings
  - [x] 13.5 Test Property 5: Non-refresh preserves data

- [x] 14. Update Documentation
  - [x] 14.1 Add --refresh to CLI usage documentation in README.md
  - [x] 14.2 Explain use cases for refresh
  - [x] 14.3 Provide examples of refresh command
  - [x] 14.4 Document clearing behavior
