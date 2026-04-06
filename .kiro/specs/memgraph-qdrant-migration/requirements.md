# Requirements Document: Memgraph + Qdrant Migration

## Introduction

Introduce an adapter pattern for graph and vector storage so that Neo4j + pgvector (existing) and Memgraph + Qdrant (new) can coexist and be selected via environment variables with zero changes to consumer query logic.

## Glossary

- **GraphAdapter**: Interface abstracting all graph database operations
- **VectorAdapter**: Interface abstracting all vector store operations
- **Neo4jAdapter**: GraphAdapter implementation wrapping existing Neo4j behavior
- **MemgraphAdapter**: GraphAdapter implementation for Memgraph (Bolt-compatible, no APOC)
- **PgvectorAdapter**: VectorAdapter implementation wrapping existing pgvector behavior
- **QdrantAdapter**: VectorAdapter implementation using `@qdrant/js-client-rest`
- **Factory**: `createGraphAdapter()` / `createVectorAdapter()` — reads env vars, returns adapter
- **Consumer**: Any module that calls graph or vector operations (CLI, MCP server, pipeline, search)

## Requirements

### Requirement 1: Adapter Interfaces

**User Story:** As a developer, I want stable interfaces for graph and vector operations, so that consumers are decoupled from concrete backend implementations.

#### Acceptance Criteria

1. THE GraphAdapter SHALL expose `createDriver`, `storeNodes`, `storeEdges`, `findNode`, `findDependents`, `findDependencies`, `traversePath`, `findProcessesBySymbol`, and `findClustersBySymbol`
2. THE VectorAdapter SHALL expose `createClient`, `initVectorStore`, `indexSymbol`, and `semanticSearch`
3. THE VectorAdapter SHALL define an opaque `VectorClient` type that hides `Pool` vs `QdrantClient` from consumers

### Requirement 2: Backend Selection via Environment Variables

**User Story:** As an operator, I want to select graph and vector backends via environment variables, so that I can switch backends without code changes.

#### Acceptance Criteria

1. WHEN `GRAPH_BACKEND=neo4j`, THE Factory SHALL return a Neo4jAdapter instance
2. WHEN `GRAPH_BACKEND=memgraph`, THE Factory SHALL return a MemgraphAdapter instance
3. WHEN `VECTOR_BACKEND=pgvector`, THE Factory SHALL return a PgvectorAdapter instance
4. WHEN `VECTOR_BACKEND=qdrant`, THE Factory SHALL return a QdrantAdapter instance
5. IF `GRAPH_BACKEND` is set to an unrecognized value, THEN THE Factory SHALL throw an error with a descriptive message
6. IF `VECTOR_BACKEND` is set to an unrecognized value, THEN THE Factory SHALL throw an error with a descriptive message
7. WHERE `GRAPH_BACKEND` is unset, THE Factory SHALL default to `neo4j`
8. WHERE `VECTOR_BACKEND` is unset, THE Factory SHALL default to `pgvector`

### Requirement 3: MemgraphAdapter

**User Story:** As a developer, I want a Memgraph-compatible graph adapter, so that the system works with Memgraph without APOC or encryption flags.

#### Acceptance Criteria

1. WHEN `MemgraphAdapter.createDriver` is called, THE MemgraphAdapter SHALL connect via Bolt without setting `encrypted: false`
2. WHEN `MemgraphAdapter.storeNodes` is called, THE MemgraphAdapter SHALL use only the `MERGE (x:Label {id}) SET x += props` path and SHALL NOT invoke any APOC procedure
3. WHEN a Memgraph connection attempt fails, THE MemgraphAdapter SHALL retry up to 3 times before throwing

### Requirement 4: QdrantAdapter

**User Story:** As a developer, I want a Qdrant vector adapter, so that the system can use Qdrant with full 3072-dimension embeddings.

#### Acceptance Criteria

1. WHEN `QdrantAdapter.initVectorStore` is called and the `embeddings` collection does not exist, THE QdrantAdapter SHALL create it with `size: 3072`, `distance: Cosine`, and `hnsw_config: { m: 16, ef_construct: 100 }`
2. WHEN `QdrantAdapter.initVectorStore` is called and the collection already exists, THE QdrantAdapter SHALL leave it unchanged
3. WHEN `QdrantAdapter.indexSymbol` is called, THE QdrantAdapter SHALL upsert a point with `id` equal to `symbolId`, `vector` equal to the embedding, and `payload` equal to metadata
4. WHEN `QdrantAdapter.semanticSearch` is called, THE QdrantAdapter SHALL return `SearchResult[]` with `symbolId`, `score`, and `metadata` mapped from Qdrant hit fields
5. WHEN a Qdrant operation fails, THE QdrantAdapter SHALL retry up to 3 times before throwing

### Requirement 5: Dimension Parity

**User Story:** As a developer, I want each adapter to request the correct embedding dimensions, so that vectors are stored at the right resolution for each backend.

#### Acceptance Criteria

1. THE QdrantAdapter SHALL use 3072 dimensions for all vector operations
2. THE PgvectorAdapter SHALL use 1536 dimensions for all vector operations

### Requirement 6: Consumer Isolation

**User Story:** As a developer, I want all consumers to program against adapter interfaces only, so that switching backends requires zero query logic changes.

#### Acceptance Criteria

1. THE System SHALL update `executor.ts`, `server.ts`, `pipeline.ts`, `smart-search.ts`, `handler.ts`, and `tools.ts` to accept `GraphAdapter` and `VectorAdapter` instead of `Driver` and `Pool`
2. WHEN the backend is switched via env var, THE Consumer SHALL execute without any query logic modification

### Requirement 7: Infrastructure

**User Story:** As an operator, I want Memgraph and Qdrant available in docker-compose, so that both backends can run locally alongside the existing services.

#### Acceptance Criteria

1. THE docker-compose.yml SHALL include a `memgraph` service on port 7687 with a health check
2. THE docker-compose.yml SHALL include a `qdrant` service on port 6333 with a health check
3. THE docker-compose.yml SHALL preserve the existing `neo4j` and `pgvector` services unchanged

### Requirement 8: Backward Compatibility

**User Story:** As a developer, I want the Neo4j and pgvector adapters to preserve all existing behavior, so that there is zero regression risk when the adapter layer is introduced.

#### Acceptance Criteria

1. WHEN `GRAPH_BACKEND=neo4j`, THE Neo4jAdapter SHALL produce identical query results to the pre-adapter implementation
2. WHEN `VECTOR_BACKEND=pgvector`, THE PgvectorAdapter SHALL produce identical query results to the pre-adapter implementation
3. THE System SHALL pass all existing graph query tests without modification after the adapter layer is introduced
