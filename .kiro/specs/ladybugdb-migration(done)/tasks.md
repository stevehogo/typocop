# Tasks: Full Migration to LadybugDB

**Related:** [Migration & Cleanup Tasks](./tasks-migration.md)

## Task 1: Create adapter interfaces and shared types
_Skills: `typescript-expert`_
- [x] 1.1 Create `src/db/types.ts` with `GraphNode`, `GraphRelationship`, `GraphAdapter`, `VectorAdapter`, `EmbeddingAdapter`, `DatabaseAdapter` interfaces
      _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
- [x] 1.2 Create `src/config/types.ts` with `OllamaConfig`, `LadybugDBConfig`, `FullConfig` types
      _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_
- [x] 1.3 Update `src/types/index.ts` to make `Embedding.dimensions` variable (remove fixed 1536 constraint)
      _Requirements: 9.1, 9.2, 9.3_

## Task 2: Extend ConfigurationManager
_Skills: `typescript-expert`, `error-handling-patterns`_
- [x] 2.1 Add Ollama config loading with defaults (enabled=false, url=localhost:11434, model=qwen3-embedding:4b, dimensions=2560)
      _Requirements: 5.1, 5.2, 5.3, 5.4_
- [x] 2.2 Add LadybugDB config loading — resolve `LADYBUGDB_PATH` or default to `~/.typocop/{prefix}/db.ladybug`, auto-create directory
      _Requirements: 5.5, 5.6_
- [x] 2.3 Add validation for Ollama URL format and positive dimensions
      _Requirements: 5.4, 5.6_
- [x] 2.4 Write unit tests for extended ConfigurationManager
      _Skills: `testing-patterns`, `tdd-workflow`_
      _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

## Task 3: Implement LadybugDB connection manager
_Skills: `typescript-expert`, `error-handling-patterns`_
- [x] 3.1 Create `src/db/connection.ts` with `createLadybugConnection()` — driver + SQL + retry
      _Requirements: 6.1, 6.2, 6.3, 6.4_
- [x] 3.2 Create `DatabaseConnectionError` typed error class
      _Requirements: 6.4_
- [x] 3.3 Write unit tests for connection retry logic and error handling
      _Skills: `testing-patterns`, `tdd-workflow`_
      _Requirements: 6.2, 6.4_

## Task 4: Implement LadybugGraphAdapter
_Skills: `typescript-expert`_
- [x] 4.1 Create `src/db/ladybug-graph-adapter.ts` with prefix-aware Cypher operations
      _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
- [x] 4.2 Implement `runCypher` (read) and `runCypherWrite` (write) with LadybugDB sessions
      _Requirements: 2.5, 2.6_
- [x] 4.3 Write unit tests for GraphAdapter CRUD and prefix isolation
      _Skills: `testing-patterns`, `tdd-workflow`_
      _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_
- [x] 4.4 Write property test: prefix isolation — queries with prefix P never return data from P'
      _Skills: `testing-patterns`_
      _Requirements: 2.2_

## Task 5: Implement LadybugVectorAdapter
_Skills: `typescript-expert`, `vector-database-engineer`_
- [x] 5.1 Create `src/db/ladybug-vector-adapter.ts` with LadybugDB SQL interface
      _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_
- [x] 5.2 Implement `semanticSearch` using `vector_search()` with threshold and ordering
      _Requirements: 3.4_
- [x] 5.3 Write unit tests for VectorAdapter operations
      _Skills: `testing-patterns`, `tdd-workflow`_
      _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_
- [x] 5.4 Write property test: search results ordered by descending score
      _Skills: `testing-patterns`_
      _Requirements: 3.4_
- [x] 5.5 Write property test: all search results have score >= SEMANTIC_SEARCH_THRESHOLD
      _Skills: `testing-patterns`_
      _Requirements: 3.4_

## Task 6: Implement embedding adapters
_Skills: `typescript-expert`, `error-handling-patterns`_
- [x] 6.1 Create `src/db/ollama-embedding-adapter.ts` with Ollama HTTP API
      _Requirements: 4.1, 4.2, 4.3, 4.6_
- [x] 6.2 Create `src/db/noop-embedding-adapter.ts` (always disabled, returns null)
      _Requirements: 4.4, 4.5_
- [x] 6.3 Write unit tests for OllamaEmbeddingAdapter (success, unreachable, dimension mismatch)
      _Skills: `testing-patterns`, `tdd-workflow`_
      _Requirements: 4.1, 4.2, 4.3, 4.6_
- [x] 6.4 Write unit tests for NoOpEmbeddingAdapter
      _Skills: `testing-patterns`_
      _Requirements: 4.4, 4.5_
- [x] 6.5 Write property test: embedding dimension consistency (vector.length === dimensions)
      _Skills: `testing-patterns`_
      _Requirements: 4.2, 9.2_
