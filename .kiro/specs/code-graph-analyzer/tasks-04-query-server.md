# Tasks 16–22: Query Server & Query Types

Part of the [Implementation Plan](./tasks.md).

## Tasks

- [x] 16. Implement query server and natural language processing
  - [x] 16.1 Implement query intent classification
    - _Skills: `typescript-expert`, `clean-code`_
    - Implement parseQueryIntent function delegating to AI Context Enrichment classifyIntent
    - Support all intents: ImpactAnalysis, SmartSearch, ContextRetrieval, DataFlowTrace, PreCommitCheck
    - Ensure intent confidence >= 0.7
    - _Requirements: 9.1, 9.2, 11b.1, 21.6_

  - [x] 16.2 Implement query execution engine
    - _Skills: `typescript-expert`, `error-handling-patterns`, `architecture`_
    - Implement executeQuery function combining semantic search and graph traversal
    - Calculate confidence scores for results (target >= 0.90 for production)
    - Assign risk levels based on affected symbol count (LOW: 0-2, MEDIUM: 3-10, HIGH: 11+, CRITICAL: core components)
    - Enforce maxResults limit
    - Add query timeout enforcement
    - _Requirements: 9.3, 9.4, 9.5, 9.6, 9.7, 23.3_

  - [x] 16.3 Implement result formatting
    - _Skills: `typescript-expert`, `clean-code`_
    - Implement formatResponse function for structured output
    - Include symbols, relationships, clusters, processes, confidence, risk level, affected flows
    - _Requirements: 9.4, 9.5_

  - [x]* 16.4 Write property tests for query execution
    - _Skills: `testing-patterns`, `tdd-workflow`_
    - **Property 9: Query Result Limit** - Verify result count <= maxResults
    - **Property 10: Query Confidence Bounds** - Verify confidence in [0.0, 1.0]
    - **Property 11: High Confidence Completeness** - Verify confidence >= 0.90 implies symbols exist
    - **Validates: Requirements 9.4, 9.6, 9.7, 21.2, 21.3, 21.4**

- [x] 17. Implement impact analysis queries
  - [x] 17.1 Implement impact analysis logic
    - _Skills: `typescript-expert`, `architecture`_
    - Identify target symbol from query
    - Find all direct and transitive dependents using graph traversal
    - Identify affected business processes
    - Calculate risk level based on affected count and component criticality
    - _Requirements: 10.1, 10.2, 10.3, 10.8_

  - [x] 17.2 Write property test for risk level consistency
    - _Skills: `testing-patterns`, `tdd-workflow`_
    - **Property 12: Risk Level Consistency** - Verify risk level matches affected symbol count thresholds
    - **Validates: Requirements 10.4, 10.5, 10.6, 10.7**

- [x] 18. Implement smart search queries
  - [x] 18.1 Implement smart search logic
    - _Skills: `typescript-expert`, `clean-code`_
    - Perform semantic search to find relevant symbols
    - Group symbols by cluster
    - Retrieve associated processes for each cluster
    - Order process steps sequentially
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

- [-] 19. Implement pre-commit check queries
  - [x] 19.1 Implement pre-commit check logic
    - _Skills: `typescript-expert`, `architecture`_
    - Identify all symbols defined in the changed files
    - Find all direct and transitive dependents of those symbols using graph traversal
    - Identify all affected business processes
    - Calculate risk assessment across all changed symbols
    - Generate recommendations for which flows to test
    - _Requirements: 11b.1, 11b.2, 11b.3, 11b.4, 11b.5_

- [x] 20. Implement context retrieval queries
  - [x] 20.1 Implement 360° context retrieval
    - _Skills: `typescript-expert`, `clean-code`_
    - Identify target symbol
    - Find all callers using findDependents
    - Find all callees using findDependencies
    - Find all processes containing the symbol
    - Find all clusters containing the symbol
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

- [x] 21. Implement data flow tracing queries
  - [x] 21.1 Implement end-to-end data flow tracing
    - _Skills: `typescript-expert`, `architecture`_
    - Identify entry point symbol (API endpoint)
    - Trace through controllers using call graph
    - Trace through service layers
    - Trace through repository layers
    - Identify database models at the end of the chain
    - Ensure Full tracing frameworks include API→Controller→DB path
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7_

  - [x]* 21.2 Write property test for framework tracing completeness
    - _Skills: `testing-patterns`, `tdd-workflow`_
    - **Property 16: Framework Tracing Completeness** - Verify Full tracing includes API, controllers, and DB models
    - **Property 17: Framework Partial Tracing** - Verify Partial tracing has at least one component type
    - **Validates: Requirements 13.7, 14.9, 14.10**

- [x] 22. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
