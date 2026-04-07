# File Path Context Loss Bugfix - Implementation Tasks

- [x] 1. Fix extractAllSymbols to pass full paths to extraction functions
  _Skills: `typescript-expert`, `clean-code`
  - [x] 1.1 Update extractSymbolsWithQueries call to use fullPath instead of fileNode.path
  - [x] 1.2 Update extractSymbols fallback call to use fullPath instead of fileNode.path
  - [x] 1.3 Verify symbol ID generation uses the full path

- [x] 2. Write unit tests for the fix
  _Skills: `testing-patterns`, `tdd-workflow`
  - [x] 2.1 Test that symbols contain absolute paths after extraction
  - [x] 2.2 Test that relationship hints contain absolute source file paths
  - [x] 2.3 Test that symbol IDs are unique across different scan roots

- [x] 3. Write property-based tests for preservation
  _Skills: `testing-patterns`
  - [x] 3.1 Property 1: Bug Condition - File Path Completeness (PBT)
  - [x] 3.2 Property 2: Preservation - Extraction Logic Unchanged (PBT)

- [x] 4. Write integration tests covering full pipeline and multi-language extraction
  _Skills: `testing-patterns`

- [x] 5. Run all tests and verify no regressions
