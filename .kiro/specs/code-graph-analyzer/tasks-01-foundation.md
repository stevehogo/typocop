# Tasks 1–6: Foundation

Part of the [Implementation Plan](./tasks.md).

## Tasks

- [x] 1. Set up project structure and core data models
  - _Skills: `typescript-expert`, `clean-code`_
  - Create TypeScript project with package.json and tsconfig
  - Define core data types: Symbol, SymbolKind, Location, Visibility, Modifier
  - Define relationship types: Relationship, RelationType
  - Define cluster and process models: Cluster, ClusterCategory, Process, ProcessStep, DataFlowEdge
  - Define framework support model: FrameworkSupport, TracingLevel, Language
  - Define query types: Query, QueryIntent (including preCommitCheck), QueryResult, RiskLevel
  - _Requirements: 4.2, 5.1-5.4, 6.2-6.4, 7.4-7.5, 9.1, 11b.1, 14.9-14.10_

- [x] 1.1 Write property tests for core data models
  - _Skills: `testing-patterns`, `tdd-workflow`_
  - **Property 1: Symbol Uniqueness** - Verify all symbol IDs are unique in any symbol list
  - **Property 3: Symbol Location Validity** - Verify start line ≤ end line and column ordering
  - **Property 4: Cluster Confidence Bounds** - Verify confidence scores are in [0.0, 1.0]
  - **Property 5: Cluster Minimum Size** - Verify clusters contain at least 2 symbols
  - **Validates: Requirements 4.1, 4.3, 4.4, 4.5, 6.2, 6.4**

- [x] 2. Implement CLI tool and command parsing
  - [x] 2.1 Create CLI command structure and parser
    - _Skills: `typescript-expert`, `clean-code`_
    - Define CLIConfig and CLICommand types
    - Implement command-line argument parsing for `parse`, `reindex`, and `status` commands
    - Add validation for source paths and language selection
    - _Requirements: 1.1, 1.2, 1.3, 1.6, 1.7_

  - [x] 2.2 Implement CLI execution and error handling
    - _Skills: `error-handling-patterns`, `nodejs-best-practices`_
    - Implement executeCLI function to dispatch all three commands
    - Add error handling for invalid paths and unsupported languages
    - Implement `reindex` command to re-run the pipeline against an existing database path
    - Implement `status` command to report symbol count, relationship count, and last indexed timestamp
    - Implement progress reporting and statistics output
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 18.3_

- [x] 3. Implement Tree-sitter AST parser
  - [x] 3.1 Create parser initialization and language support
    - _Skills: `typescript-expert`, `clean-code`_
    - Define Language enum with 12 supported languages (TypeScript, JavaScript, Python, PHP, Java, Go, Rust, C, C++, C#, Ruby, Swift)
    - Implement initParser function for language-specific Tree-sitter grammar initialization
    - Add language detection from file extensions
    - _Requirements: 2.1-2.12_

  - [x] 3.2 Implement AST parsing and symbol extraction
    - _Skills: `typescript-expert`, `error-handling-patterns`_
    - Define ASTNode structure for Tree-sitter output
    - Implement parseFile function to parse source files into ASTs
    - Implement extractSymbols function to extract functions, classes, methods, interfaces, variables
    - Add error handling for syntax errors with logging and file skipping
    - _Requirements: 2.13, 2.14, 18.1, 18.2_

- [x] 4. Implement Phase 1: File tree walking
  - [x] 4.1 Implement directory traversal
    - _Skills: `nodejs-best-practices`, `error-handling-patterns`_
    - Define FileNode structure
    - Implement walkFileTree function with recursive directory traversal
    - Add file filtering for source files only
    - Implement language detection for discovered files
    - _Requirements: 3.1_

- [x] 5. Implement Phase 2: Symbol extraction from ASTs
  - [x] 5.1 Implement symbol extraction pipeline
    - _Skills: `typescript-expert`, `clean-code`_
    - Implement extractAllSymbols function to process all FileNodes
    - Implement extractSymbolsFromAST recursive function
    - Create symbol ID generation with uniqueness guarantees
    - Extract symbol metadata: name, kind, location, signature, visibility, modifiers
    - _Requirements: 3.2, 4.1, 4.2_

  - [x] 5.2 Write property test for symbol extraction
    - _Skills: `testing-patterns`, `tdd-workflow`_
    - **Property 1: Symbol Uniqueness** - Verify no duplicate symbol IDs in extracted symbols
    - **Validates: Requirements 4.1, 4.3**

- [ ] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
