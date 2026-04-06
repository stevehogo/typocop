Part of the [Memgraph + Qdrant Migration](./tasks.md).

# Phase 1: Interfaces, Adapters & Factories

- [ ] 1. Define GraphAdapter and VectorAdapter interfaces
  _Skills: `typescript-expert`, `architecture`, `clean-code`
  - Create `src/graph/adapter.ts` with `GraphAdapter` interface (all 9 methods)
  - Create `src/vector/adapter.ts` with `VectorAdapter` interface, `VectorClient` opaque type, and `VectorConfig`
  - _Requirements: 1.1, 1.2, 1.3_

- [ ] 2. Implement Neo4jAdapter
  _Skills: `typescript-expert`, `clean-code`, `error-handling-patterns`
  - [ ] 2.1 Create `src/graph/neo4j-adapter.ts` delegating to existing `connection.ts`, `store.ts`, `query.ts`
    - Preserve `encrypted: false` and APOC path exactly as-is
    - _Requirements: 8.1, 8.3_
  - [ ]* 2.2 Write unit tests for Neo4jAdapter
    - Verify delegation to existing functions; mock neo4j-driver
    - _Requirements: 8.1_

- [ ] 3. Implement MemgraphAdapter
  _Skills: `typescript-expert`, `error-handling-patterns`, `clean-code`
  - [ ] 3.1 Create `src/graph/memgraph-adapter.ts`
    - `createDriver`: omit `encrypted` flag; wrap in `withRetry` (3 attempts)
    - `storeNodes`: MERGE-only loop, no APOC call
    - All query methods identical to Neo4jAdapter (same Cypher)
    - _Requirements: 3.1, 3.2, 3.3_
  - [ ]* 3.2 Write unit tests for MemgraphAdapter
    - Assert no `encrypted` key in driver options
    - Assert no `apoc.` string in any Cypher run during `storeNodes`
    - _Requirements: 3.1, 3.2_

- [ ] 4. Implement PgvectorAdapter
  _Skills: `typescript-expert`, `clean-code`, `postgresql`
  - [ ] 4.1 Create `src/vector/pgvector-adapter.ts` delegating to existing `connection.ts`, `index-store.ts`, `search.ts`
    - Confirm 1536-dimension usage is preserved
    - _Requirements: 5.2, 8.2_
  - [ ]* 4.2 Write unit tests for PgvectorAdapter
    - Mock `pg.Pool`; verify delegation and 1536-dim constraint
    - _Requirements: 5.2, 8.2_

- [ ] 5. Implement QdrantAdapter
  _Skills: `typescript-expert`, `vector-database-engineer`, `error-handling-patterns`
  - [ ] 5.1 Add `@qdrant/js-client-rest` dependency via `pnpm add @qdrant/js-client-rest`
    - _Requirements: 4.1_
  - [ ] 5.2 Create `src/vector/qdrant-adapter.ts`
    - `createClient`: connect with optional `apiKey`; wrap in `withRetry` (3 attempts)
    - `initVectorStore`: create `embeddings` collection only if absent (`size: 3072`, `distance: Cosine`, `hnsw_config: { m: 16, ef_construct: 100 }`)
    - `indexSymbol`: upsert point with `id=symbolId`, `vector`, `payload=metadata`, `wait: true`
    - `semanticSearch`: map hits to `SearchResult[]` (`symbolId`, `score`, `metadata`)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.1_
  - [ ]* 5.3 Write unit tests for QdrantAdapter
    - Mock `@qdrant/js-client-rest`; verify upsert shape and search mapping
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [ ] 6. Implement adapter factory functions
  _Skills: `typescript-expert`, `error-handling-patterns`, `clean-code`
  - [ ] 6.1 Create `src/graph/adapter-factory.ts`
    - `createGraphAdapter(backend)`: return `Neo4jAdapter` or `MemgraphAdapter`; throw descriptive error on unknown value; default to `neo4j`
    - _Requirements: 2.1, 2.2, 2.5, 2.7_
  - [ ] 6.2 Create `src/vector/adapter-factory.ts`
    - `createVectorAdapter(backend)`: return `PgvectorAdapter` or `QdrantAdapter`; throw descriptive error on unknown value; default to `pgvector`
    - _Requirements: 2.3, 2.4, 2.6, 2.8_
  - [ ]* 6.3 Write unit tests for both factories
    - Verify correct class returned for each valid string; verify throw for invalid strings
    - _Requirements: 2.1–2.8_

- [ ] 7. Checkpoint — ensure Phase 1 tests pass
  - Run `pnpm vitest --run` and confirm all adapter and factory tests pass. Ask the user if questions arise.
