# Tasks 7–10: Indexing Pipeline (Phases 3–5)

Part of the [Implementation Plan](./tasks.md).

## Tasks

- [x] 7. Implement Phase 3: Reference resolution
  - [x] 7.1 Implement import resolution
    - _Skills: `typescript-expert`, `clean-code`_
    - Build symbol map for fast lookups
    - Implement findImports function to extract import statements from symbols
    - Implement resolveImport function to match imports to target symbols
    - Create Imports relationships with unresolved flag for missing targets
    - _Requirements: 3.3, 5.1, 5.6_

  - [x] 7.2 Implement call resolution
    - _Skills: `typescript-expert`, `clean-code`_
    - Implement findCalls function to extract function calls from symbols
    - Implement resolveCall function to match calls to target symbols
    - Create Calls relationships
    - _Requirements: 3.3, 5.2_

  - [x] 7.3 Implement inheritance and interface resolution
    - _Skills: `typescript-expert`, `clean-code`_
    - Implement inheritance detection for class hierarchies
    - Implement interface implementation detection
    - Create Inherits and Implements relationships
    - _Requirements: 3.3, 5.3, 5.4_

  - [x] 7.4 Write property tests for relationship resolution
    - _Skills: `testing-patterns`, `tdd-workflow`_
    - **Property 2: Relationship Validity** - Verify all relationships reference existing symbols
    - **Validates: Requirements 5.5, 5.7**

- [ ] 8. Implement Phase 4: Symbol clustering
  - [ ] 8.1 Implement graph construction for clustering
    - _Skills: `typescript-expert`, `architecture`_
    - Build adjacency graph from symbols and relationships
    - Implement graph data structure for community detection
    - _Requirements: 3.4, 6.1_

  - [ ] 8.2 Implement Louvain community detection
    - _Skills: `typescript-expert`, `architecture`_
    - Implement Louvain clustering algorithm
    - Calculate modularity scores for cluster quality
    - Generate confidence scores based on community metrics
    - _Requirements: 3.4, 6.2, 21.5_

  - [ ] 8.3 Implement cluster enrichment via AI Context Enrichment component
    - _Skills: `typescript-expert`, `error-handling-patterns`_
    - Implement enrichCluster function calling inferClusterName and classifyCluster
    - Implement inferClusterName using AI to generate descriptive names from symbol semantics
    - Implement classifyCluster to categorize clusters (Authentication, DataAccess, BusinessLogic, UIComponent, Utility, Unknown)
    - Ensure minimum cluster size of 2 symbols
    - _Requirements: 3.4, 6.3, 6.4, 6.6, 24.1, 24.2_

  - [ ]* 8.4 Write property tests for clustering
    - _Skills: `testing-patterns`, `tdd-workflow`_
    - **Property 4: Cluster Confidence Bounds** - Verify confidence in [0.0, 1.0]
    - **Property 5: Cluster Minimum Size** - Verify at least 2 symbols per cluster
    - **Property 6: Cluster Symbol Validity** - Verify all symbol IDs exist
    - **Validates: Requirements 6.2, 6.4, 6.5**

- [ ] 9. Implement Phase 5: Process tracing
  - [ ] 9.1 Implement entry point detection
    - _Skills: `typescript-expert`, `clean-code`_
    - Implement findEntryPoints function to identify API endpoints, main functions, controllers
    - Build call graph from relationships
    - _Requirements: 3.5, 7.1_

  - [ ] 9.2 Implement execution flow tracing
    - _Skills: `typescript-expert`, `error-handling-patterns`_
    - Implement traceExecution recursive function with cycle detection
    - Use visited set to prevent infinite loops
    - Create ProcessStep records in sequential order
    - Filter processes with fewer than 2 steps
    - _Requirements: 3.5, 7.2, 7.3, 7.4, 7.6_

  - [ ] 9.3 Implement data flow analysis
    - _Skills: `typescript-expert`, `clean-code`_
    - Implement analyzeDataFlow function to trace data between steps
    - Create DataFlowEdge records
    - Implement inferProcessName function
    - _Requirements: 3.5, 7.5, 7.7_

  - [ ]* 9.4 Write property tests for process tracing
    - _Skills: `testing-patterns`, `tdd-workflow`_
    - **Property 7: Process Step Ordering** - Verify steps are sequentially ordered
    - **Property 8: Process Minimum Length** - Verify at least 2 steps per process
    - **Validates: Requirements 7.4, 7.6, 11.4**

- [ ] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
