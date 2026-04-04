# Tasks 11–15: Search Index, AI Enrichment, Databases

Part of the [Implementation Plan](./tasks.md).

## Tasks

- [x] 11. Implement Phase 6: Search index building
  - [x] 11.1 Implement embedding generation
    - _Skills: `typescript-expert`, `error-handling-patterns`_
    - Implement formatSymbolForEmbedding function
    - Implement formatClusterForEmbedding function
    - Implement embedText function to call embedding API (text-embedding-3-large, 3072 dimensions)
    - Add fallback handling for unavailable embedding service
    - _Requirements: 3.6, 8.1, 8.2, 8.3, 8.6_

  - [x] 11.2 Implement keyword indexing
    - _Skills: `typescript-expert`, `clean-code`_
    - Implement extractKeywords function for symbols
    - Build keyword-to-symbol mappings
    - Create SearchIndex data structure
    - _Requirements: 3.6, 8.4, 8.5_

  - [ ]* 11.3 Write property test for embeddings
    - _Skills: `testing-patterns`, `tdd-workflow`_
    - **Property 14: Embedding Dimensionality** - Verify all embeddings have 3072 dimensions
    - **Validates: Requirement 8.3**

- [ ] 12. Implement AI Context Enrichment component
  - [ ] 12.1 Implement EnrichmentConfig and task dispatch
    - _Skills: `typescript-expert`, `architecture`_
    - Define EnrichmentConfig interface (embeddingModel, dimensions, feature flags)
    - Define EnrichmentTask discriminated union (dependencyMapping, intentClassification, sideEffectAnalysis, typeInference)
    - Implement enrichCluster function that applies name generation and classification
    - _Requirements: 24.1, 24.2_

  - [ ] 12.2 Implement side effect analysis and type inference
    - _Skills: `typescript-expert`, `clean-code`_
    - Implement analyzeSideEffects function to identify mutations and I/O for a symbol
    - Implement inferTypes function to infer types for symbols in dynamically typed languages
    - Wire both into the enrichment pipeline
    - _Requirements: 24.4, 24.5_

  - [ ] 12.3 Implement intent classification with confidence scoring
    - _Skills: `typescript-expert`, `error-handling-patterns`_
    - Implement classifyIntent function returning QueryIntent with confidence score
    - Ensure returned confidence is always >= 0.7
    - _Requirements: 9.2, 24.3, 21.6_

  - [ ]* 12.4 Write property test for intent classification confidence
    - _Skills: `testing-patterns`, `tdd-workflow`_
    - **Property 13: Intent Classification Confidence** - Verify intent confidence >= 0.7
    - **Validates: Requirements 9.2, 21.6, 24.3**

- [ ] 13. Implement graph database interface
  - [ ] 13.1 Create graph database connection and storage
    - _Skills: `typescript-expert`, `error-handling-patterns`_
    - Define GraphNode and GraphEdge structures
    - Implement storeNodes function to create nodes with labels and properties
    - Implement storeEdges function to create edges with types and properties
    - Add connection retry logic with exponential backoff (3 attempts)
    - _Requirements: 3.8, 16.1, 16.2, 19.1, 19.2_

  - [ ] 13.2 Implement graph query operations
    - _Skills: `typescript-expert`, `sql-optimization-patterns`_
    - Implement findNode function with <100ms target
    - Implement findDependents function for traversing to callers
    - Implement findDependencies function for traversing to callees
    - Implement traversePath function for finding paths between symbols
    - Add maximum depth limit enforcement to prevent infinite loops
    - _Requirements: 16.3, 16.4, 16.5, 16.6, 16.7, 20.5, 23.4_

  - [ ]* 13.3 Write property test for graph traversal
    - _Skills: `testing-patterns`, `tdd-workflow`_
    - **Property 18: Graph Traversal Depth Limit** - Verify depth never exceeds maximum
    - **Validates: Requirement 16.7**

- [ ] 14. Implement vector store interface
  - [ ] 14.1 Create vector database connection and indexing
    - _Skills: `typescript-expert`, `error-handling-patterns`_
    - Define Embedding and SearchResult structures
    - Implement indexSymbol function to store embeddings in pgvector
    - Use HNSW algorithm for approximate nearest neighbor search
    - Add connection retry logic with exponential backoff (3 attempts)
    - _Requirements: 17.1, 17.5, 19.3, 19.4_

  - [ ] 14.2 Implement semantic search
    - _Skills: `typescript-expert`, `sql-optimization-patterns`_
    - Implement semanticSearch function with <100ms target
    - Return results with similarity scores
    - Order results by descending score
    - _Requirements: 17.2, 17.3, 17.4, 20.4_

  - [ ]* 14.3 Write property test for search result ordering
    - _Skills: `testing-patterns`, `tdd-workflow`_
    - **Property 15: Search Result Ordering** - Verify descending score order
    - **Validates: Requirement 17.4**

- [ ] 15. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
