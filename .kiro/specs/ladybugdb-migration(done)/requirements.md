# Requirements: Full Migration to LadybugDB

## Requirement 1: Database Adapter Abstraction Layer

### Description
Introduce a `DatabaseAdapter` interface that abstracts all graph, vector, and embedding operations, decoupling the query layer and indexer from the underlying database engine.

### Acceptance Criteria
- 1.1 A `DatabaseAdapter` interface exists with `initialize()`, `close()`, `getGraphAdapter()`, `getVectorAdapter()`, `getEmbeddingAdapter()` methods.
- 1.2 A `GraphAdapter` interface exists with `createNode`, `createRelationship`, `queryNodes`, `queryRelationships`, `deleteNodesByLabel`, `deleteRelationshipsByType`, `runCypher`, `runCypherWrite` methods.
- 1.3 A `VectorAdapter` interface exists with `createTables`, `indexSymbol`, `semanticSearch`, `deleteAll` methods.
- 1.4 An `EmbeddingAdapter` interface exists with `isEnabled`, `embedText`, `getDimensions` methods.
- 1.5 All interfaces use `readonly` properties and explicit return types per TypeScript standards.

## Requirement 2: LadybugDB Graph Adapter

### Description
Implement `LadybugGraphAdapter` that executes Cypher queries against LadybugDB's auto-transpilation engine, replacing the Neo4j `GraphStore`.

### Acceptance Criteria
- 2.1 `LadybugGraphAdapter` implements `GraphAdapter` using LadybugDB's Cypher-compatible session API.
- 2.2 All node labels and relationship types are prefix-aware (prepends `TYPOCOP_PREFIX`).
- 2.3 `createNode` uses `MERGE` with `SET` for upsert semantics, matching current Neo4j behavior.
- 2.4 `createRelationship` uses `MATCH` + `MERGE` pattern, matching current Neo4j behavior.
- 2.5 `runCypher` supports read transactions; `runCypherWrite` supports write transactions.
- 2.6 All existing Cypher queries in the query layer work unchanged through the adapter.

## Requirement 3: LadybugDB Vector Adapter

### Description
Implement `LadybugVectorAdapter` that stores embeddings and performs ANN search via LadybugDB's `vector_search()` function, replacing PostgreSQL + pgvector.

### Acceptance Criteria
- 3.1 `LadybugVectorAdapter` implements `VectorAdapter` using LadybugDB's SQL interface.
- 3.2 `createTables` creates a prefix-aware embeddings table with variable-dimension vector column.
- 3.3 `indexSymbol` uses UPSERT semantics (INSERT ON CONFLICT UPDATE).
- 3.4 `semanticSearch` uses `vector_search()` and returns results with `score >= 0.70` ordered descending.
- 3.5 Embedding dimensions are variable (not fixed at 1536), determined by the `EmbeddingAdapter`.

## Requirement 4: Ollama Embedding Adapter

### Description
Implement `OllamaEmbeddingAdapter` that generates embeddings locally via Ollama HTTP API, and `NoOpEmbeddingAdapter` for when embeddings are disabled.

### Acceptance Criteria
- 4.1 `OllamaEmbeddingAdapter` calls `POST {OLLAMA_URL}/api/embeddings` with configured model.
- 4.2 `OllamaEmbeddingAdapter` validates response dimensions match `OLLAMA_DIMENSIONS` config.
- 4.3 `OllamaEmbeddingAdapter` returns `null` when Ollama is unreachable (no throw).
- 4.4 `NoOpEmbeddingAdapter.isEnabled()` returns `false`; `embedText()` returns `null`.
- 4.5 `NoOpEmbeddingAdapter` is used when `OLLAMA_ENABLED` is unset or `"false"`.
- 4.6 All text sent to Ollama passes `verifyEmbeddingText()` privacy check (no source code).

## Requirement 5: Configuration Manager Extensions

### Description
Extend `ConfigurationManager` to load and validate Ollama and LadybugDB configuration from environment variables.

### Acceptance Criteria
- 5.1 `OLLAMA_ENABLED` defaults to `false` when unset.
- 5.2 `OLLAMA_URL` defaults to `"http://localhost:11434"` when unset.
- 5.3 `OLLAMA_MODEL` defaults to `"qwen3-embedding:4b"` when unset.
- 5.4 `OLLAMA_DIMENSIONS` defaults to `2560` when unset; must be a positive integer.
- 5.5 `LADYBUGDB_PATH` overrides the database directory when set; when unset, defaults to `~/.typocop/{prefix}/db.ladybug` (per-project isolation).
- 5.6 The database directory is auto-created if it does not exist.
- 5.7 Invalid `OLLAMA_URL` (non-HTTP URL) is rejected with a validation error.
- 5.8 Removed env vars: `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `POSTGRES_*`, `OPENAI_API_KEY`.

## Requirement 6: LadybugDB Connection Management

### Description
Implement connection lifecycle for LadybugDB with retry logic and proper cleanup.

### Acceptance Criteria
- 6.1 LadybugDB driver is created with `GraphDatabase.driver("ladybug://" + dbPath)`.
- 6.2 Connection uses retry with exponential backoff (max 3 attempts, 200ms/400ms/800ms).
- 6.3 `close()` properly shuts down both the Cypher driver and SQL connection.
- 6.4 Connection failure after all retries throws `DatabaseConnectionError` with path and cause.

## Requirement 7: Query Layer Migration

### Description
Migrate the query layer to use `DatabaseAdapter` instead of direct Neo4j `Session` and PostgreSQL `Pool`.

### Acceptance Criteria
- 7.1 `executeQuery()` accepts `DatabaseAdapter` instead of `Pool` + `Session` + `prefix`.
- 7.2 Impact analysis, context retrieval, data flow trace use `GraphAdapter.runCypher()`.
- 7.3 Smart search uses `VectorAdapter.semanticSearch()` when embeddings are enabled.
- 7.4 Smart search returns empty results (no throw) when embeddings are disabled.
- 7.5 All five query types produce correct results through the adapter layer.

## Requirement 8: Indexer Pipeline Migration

### Description
Migrate the 6-phase indexer pipeline to use `DatabaseAdapter` for storage and optional Ollama for embeddings.

### Acceptance Criteria
- 8.1 Phases 1-5 write graph data through `GraphAdapter` instead of Neo4j sessions.
- 8.2 Phase 6 uses `EmbeddingAdapter.embedText()` instead of OpenAI `embedText()`.
- 8.3 Phase 6 skips embedding generation when `EmbeddingAdapter.isEnabled()` is false.
- 8.4 Phase 6 stores embeddings through `VectorAdapter.indexSymbol()`.
- 8.5 Keyword indexing (non-embedding) continues to work regardless of Ollama state.

## Requirement 9: Embedding Type Update

### Description
Update the `Embedding` type to support variable dimensions instead of fixed 1536.

### Acceptance Criteria
- 9.1 `Embedding.dimensions` is no longer fixed at 1536; it reflects the actual model output.
- 9.2 `Embedding.vector.length === Embedding.dimensions` invariant is enforced.
- 9.3 All code referencing hardcoded 1536 dimensions is updated to use config-driven values.

## Requirement 10: Ollama-Powered Cluster Classification

### Description
When Ollama is enabled, use the embedding model to semantically classify clusters into categories, reducing the number of `"unknown"` clusters. Falls back to keyword-based classification when Ollama is disabled.

### Acceptance Criteria
- 10.1 When `OLLAMA_ENABLED=true`, Phase 4 (clustering) uses Ollama embeddings to classify clusters by comparing cluster content embeddings against category reference embeddings.
- 10.2 The semantic classifier computes cosine similarity between a cluster's aggregated embedding and predefined category embeddings, selecting the highest-scoring category above a threshold (≥ 0.50).
- 10.3 If no category scores above the threshold, the cluster remains `"unknown"`.
- 10.4 When `OLLAMA_ENABLED=false`, the existing keyword-based `classifyCluster()` is used unchanged.
- 10.5 Category reference embeddings are generated once per indexing run and cached in memory.
- 10.6 Privacy: only symbol names, kinds, and signatures are used for cluster text — no source code.

## Requirement 11: Dependency Cleanup

### Description
Remove Neo4j, PostgreSQL, and OpenAI dependencies after migration is complete.

### Acceptance Criteria
- 11.1 `neo4j-driver` is removed from `package.json`.
- 11.2 `pg` is removed from `package.json`.
- 11.3 `openai` is removed from `package.json`.
- 11.4 `ladybugdb` is added to `package.json`.
- 11.5 No source file imports from `neo4j-driver`, `pg`, or `openai`.
- 11.6 `.env-typocop` is updated to remove old vars and add new ones.
- 11.7 Docker Compose is simplified (no Neo4j/PostgreSQL services).
