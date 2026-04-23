# Tasks: Migration & Cleanup

Part of the [Full Migration to LadybugDB Tasks](./tasks.md).

## Task 7: Create DatabaseAdapter facade
_Skills: `typescript-expert`_
- [x] 7.1 Create `src/db/database-adapter.ts` — wires LadybugDB connection to graph, vector, embedding adapters
      _Requirements: 1.1, 6.1, 6.3_
- [x] 7.2 Create factory `createDatabaseAdapter(config)` selecting Ollama or NoOp based on config
      _Requirements: 4.5, 5.1_
- [x] 7.3 Write unit tests for DatabaseAdapter initialization and adapter wiring
      _Skills: `testing-patterns`, `tdd-workflow`_
      _Requirements: 1.1_

## Task 8: Migrate query layer to use DatabaseAdapter
_Skills: `typescript-expert`_
- [x] 8.1 Update `executeQuery()` to accept `DatabaseAdapter` instead of `Pool` + `Session` + `prefix`
      _Requirements: 7.1_
- [x] 8.2 Update impact analysis, context retrieval, data flow trace to use `GraphAdapter.runCypher()`
      _Requirements: 7.2_
- [x] 8.3 Update smart search to use `VectorAdapter.semanticSearch()` and `EmbeddingAdapter.embedText()`
      _Requirements: 7.3, 7.4_
- [x] 8.4 Update pre-commit check to use `GraphAdapter`
      _Requirements: 7.2_
- [x] 8.5 Write unit tests verifying all five query types work through the adapter
      _Skills: `testing-patterns`, `tdd-workflow`_
      _Requirements: 7.5_

## Task 9: Migrate indexer pipeline to use DatabaseAdapter
_Skills: `typescript-expert`_
- [x] 9.1 Update indexer phases 1-5 to write through `GraphAdapter` instead of Neo4j sessions
      _Requirements: 8.1_
- [x] 9.2 Update Phase 6 to use `EmbeddingAdapter` and `VectorAdapter` instead of OpenAI + pgvector
      _Requirements: 8.2, 8.3, 8.4, 8.5_
- [x] 9.3 Write unit tests for indexer pipeline with mocked DatabaseAdapter
      _Skills: `testing-patterns`, `tdd-workflow`_
      _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

## Task 10: Update MCP server and CLI entry points
_Skills: `typescript-expert`_
- [x] 10.1 Update MCP server to create and use `DatabaseAdapter` instead of Neo4j driver + PG pool
      _Requirements: 7.1_
- [x] 10.2 Update CLI entry point to initialize `DatabaseAdapter` from `FullConfig`
      _Requirements: 7.1, 5.1_
- [x] 10.3 Write unit tests for MCP server adapter integration
      _Skills: `testing-patterns`_
      _Requirements: 7.5_

## Task 11: Implement Ollama-powered cluster classification
_Skills: `typescript-expert`, `vector-database-engineer`_
- [x] 11.1 Create `src/indexer/clustering/semantic-classifier.ts` with `SemanticClusterClassifier` class
      _Requirements: 10.1, 10.2, 10.3_
- [x] 11.2 Define category reference texts (one descriptive paragraph per `ClusterCategory`) and embed them via `EmbeddingAdapter` on first use
      _Requirements: 10.5_
- [x] 11.3 Implement `classifyClusterSemantic()` — aggregate cluster symbol text, embed it, compare cosine similarity against cached category embeddings, return best match above threshold
      _Requirements: 10.1, 10.2, 10.3_
- [x] 11.4 Update `enrichCluster()` to accept optional `EmbeddingAdapter` and use semantic classification when enabled, keyword fallback otherwise
      _Requirements: 10.4_
- [x] 11.5 Ensure privacy: only symbol names, kinds, signatures used in cluster text — verify via `verifyEmbeddingText()`
      _Requirements: 10.6_
- [x] 11.6 Write unit tests for semantic classifier (mock embeddings, threshold behavior, fallback)
      _Skills: `testing-patterns`, `tdd-workflow`_
      _Requirements: 10.1, 10.2, 10.3, 10.4_
- [x] 11.7 Write property test: semantic classification never returns a category not in `ClusterCategory`
      _Skills: `testing-patterns`_
      _Requirements: 10.2_

## Task 12: Dependency cleanup and environment update
_Skills: `typescript-expert`_
- [x] 12.1 Remove `neo4j-driver`, `pg`, `openai` from `package.json`; add `ladybugdb`
      _Requirements: 11.1, 11.2, 11.3, 11.4_
- [x] 12.2 Delete `src/graph/` directory (connection.ts, graph-store.ts)
      _Requirements: 11.5_
- [x] 12.3 Delete `src/vector/` directory (connection.ts, vector-store.ts, embed.ts, search.ts)
      _Requirements: 11.5_
- [x] 12.4 Delete `src/indexer/search/embed.ts` (OpenAI embedding logic)
      _Requirements: 11.5_
- [x] 12.5 Update `.env-typocop` and `.env.example` — remove old vars, add LADYBUGDB_PATH (optional) and OLLAMA_*
      _Requirements: 11.6, 5.8_
- [x] 12.6 Update or remove Docker Compose to remove Neo4j and PostgreSQL services
      _Requirements: 11.7_
- [x] 12.7 Verify no source file imports from `neo4j-driver`, `pg`, or `openai`
      _Requirements: 11.5_
